import os
import time
import json
import queue
import stat
import threading
import subprocess
import paramiko
from flask import Flask, render_template, request, jsonify, Response, send_file
from flask_cors import CORS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__,
            template_folder=os.path.join(BASE_DIR, 'templates'),
            static_folder=os.path.join(BASE_DIR, 'static'))
CORS(app)

# Global SSH configuration state
ssh_config = {
    "host": "research.local",
    "port": 22,
    "username": "vct",
    "password": "vct@43",
    "base_dir": "/home/vct/VCT"
}

# Track running execution tasks
active_executions = {}  # execution_id -> {"client": SSHClient, "channel": Channel, "running": bool}

def get_ssh_client(host=None, port=None, username=None, password=None, timeout=5):
    """Creates a new paramiko SSH client connection with smart multi-host fallback."""
    target_host = host or ssh_config["host"]
    target_port = int(port or ssh_config["port"])
    target_user = username or ssh_config["username"]
    target_pass = password or ssh_config["password"]
    
    # Candidate hosts to try in order
    candidates = [target_host]
    for fallback in ["research.local", "192.168.8.173", "172.20.10.9"]:
        if fallback not in candidates:
            candidates.append(fallback)
            
    last_exception = None
    for candidate in candidates:
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(candidate, port=target_port, username=target_user, password=target_pass, timeout=timeout)
            # Update working host in config
            ssh_config["host"] = candidate
            return client
        except Exception as e:
            last_exception = e
            try:
                client.close()
            except:
                pass
                
    raise last_exception if last_exception else Exception("Could not connect to Raspberry Pi on any known host IP.")

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/connect', methods=['POST'])
def test_connection():
    """Verify SSH connection credentials and locate VCT folder."""
    data = request.json or {}
    host = data.get("host", ssh_config["host"])
    port = data.get("port", ssh_config["port"])
    username = data.get("username", ssh_config["username"])
    password = data.get("password", ssh_config["password"])
    
    try:
        client = get_ssh_client(host, port, username, password)
        
        # Check VCT folder existence
        stdin, stdout, stderr = client.exec_command("cd ~/VCT && pwd && ls -la")
        out = stdout.read().decode('utf-8', errors='ignore')
        err = stderr.read().decode('utf-8', errors='ignore')
        client.close()
        
        if "No such file or directory" in err:
            return jsonify({
                "status": "error",
                "message": "Connected to Pi, but ~/VCT directory was not found!"
            }), 404
            
        # Update global config on successful connection
        ssh_config["host"] = host
        ssh_config["port"] = port
        ssh_config["username"] = username
        ssh_config["password"] = password
        
        return jsonify({
            "status": "success",
            "message": "Connected successfully to Raspberry Pi!",
            "working_directory": "/home/vct/VCT",
            "host": host,
            "username": username
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": f"Connection failed: {str(e)}"
        }), 500

@app.route('/api/scripts', methods=['GET'])
def list_scripts():
    """List Python files and folders in ~/VCT."""
    subpath = request.args.get("path", "").strip("/")
    target_dir = f"/home/vct/VCT/{subpath}" if subpath else "/home/vct/VCT"
    
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        
        items = []
        for attr in sftp.listdir_attr(target_dir):
            name = attr.filename
            is_dir = stat.S_ISDIR(attr.st_mode)
            is_py = name.endswith('.py')
            size = attr.st_size
            mtime = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(attr.st_mtime))
            
            items.append({
                "name": name,
                "is_dir": is_dir,
                "is_python": is_py,
                "size": size,
                "modified": mtime,
                "path": f"{subpath}/{name}".strip("/")
            })
            
        sftp.close()
        client.close()
        
        # Sort directories first, then python files, then others
        items.sort(key=lambda x: (not x["is_dir"], not x["is_python"], x["name"].lower()))
        
        return jsonify({
            "status": "success",
            "current_dir": target_dir,
            "subpath": subpath,
            "items": items
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/file/read', methods=['GET'])
def read_file():
    """Read contents of a file in ~/VCT."""
    rel_path = request.args.get("path", "")
    if not rel_path:
        return jsonify({"status": "error", "message": "File path required"}), 400
        
    full_path = f"/home/vct/VCT/{rel_path.strip('/')}"
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        with sftp.open(full_path, 'r') as f:
            content = f.read().decode('utf-8', errors='ignore')
        sftp.close()
        client.close()
        
        return jsonify({
            "status": "success",
            "path": rel_path,
            "content": content
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/file/save', methods=['POST'])
def save_file():
    """Save content to a file in ~/VCT."""
    data = request.json or {}
    rel_path = data.get("path", "")
    content = data.get("content", "")
    
    if not rel_path:
        return jsonify({"status": "error", "message": "File path required"}), 400
        
    full_path = f"/home/vct/VCT/{rel_path.strip('/')}"
    try:
        client = get_ssh_client()
        sftp = client.open_sftp()
        with sftp.open(full_path, 'w') as f:
            f.write(content)
        sftp.close()
        client.close()
        
        return jsonify({
            "status": "success",
            "message": f"Successfully saved {rel_path}"
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/system_info', methods=['GET'])
def system_info():
    """Query Raspberry Pi system diagnostics."""
    try:
        client = get_ssh_client()
        
        # Combined bash script to fetch all stats in one SSH call
        cmd = """
        echo "=== TEMP ==="
        vcgencmd measure_temp 2>/dev/null || cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null
        echo "=== MEM ==="
        free -m
        echo "=== DISK ==="
        df -h /
        echo "=== UPTIME ==="
        uptime -p
        echo "=== CPU ==="
        top -bn1 | head -n 5
        """
        stdin, stdout, stderr = client.exec_command(cmd)
        output = stdout.read().decode('utf-8', errors='ignore')
        client.close()
        
        # Parse sections
        temp_val = "N/A"
        mem_info = {"total": "N/A", "used": "N/A", "free": "N/A", "percent": 0}
        disk_info = {"total": "N/A", "used": "N/A", "free": "N/A", "percent": 0}
        uptime_val = "N/A"
        cpu_val = "0%"
        
        if "=== TEMP ===" in output:
            parts = output.split("===")
            for i in range(1, len(parts), 2):
                header = parts[i].strip()
                body = parts[i+1].strip() if i+1 < len(parts) else ""
                
                if header == "TEMP":
                    if "temp=" in body:
                        temp_val = body.replace("temp=", "").strip()
                    elif body.isdigit():
                        temp_val = f"{float(body)/1000:.1f}'C"
                    else:
                        temp_val = body or "N/A"
                elif header == "MEM":
                    lines = body.splitlines()
                    for line in lines:
                        if line.startswith("Mem:"):
                            m_parts = line.split()
                            if len(m_parts) >= 4:
                                total_m = int(m_parts[1])
                                used_m = int(m_parts[2])
                                mem_info["total"] = f"{total_m} MB"
                                mem_info["used"] = f"{used_m} MB"
                                mem_info["free"] = f"{m_parts[3]} MB"
                                mem_info["percent"] = round((used_m / total_m) * 100, 1) if total_m else 0
                elif header == "DISK":
                    lines = body.splitlines()
                    if len(lines) >= 2:
                        d_parts = lines[1].split()
                        if len(d_parts) >= 5:
                            disk_info["total"] = d_parts[1]
                            disk_info["used"] = d_parts[2]
                            disk_info["free"] = d_parts[3]
                            pct_str = d_parts[4].replace("%", "")
                            disk_info["percent"] = float(pct_str) if pct_str.replace('.', '', 1).isdigit() else 0
                elif header == "UPTIME":
                    uptime_val = body.replace("up ", "").strip()
                elif header == "CPU":
                    for line in body.splitlines():
                        if "Cpu(s):" in line or "%Cpu(s):" in line:
                            # e.g., %Cpu(s): 12.5 us, 3.1 sy...
                            if "us," in line:
                                us_val = line.split("us,")[0].split()[-1]
                                cpu_val = f"{us_val}%"
                                
        return jsonify({
            "status": "success",
            "temp": temp_val,
            "memory": mem_info,
            "disk": disk_info,
            "uptime": uptime_val,
            "cpu": cpu_val,
            "raw": output
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/stream_run')
def stream_run():
    """SSE endpoint: Runs a python script inside ~/VCT and streams output live."""
    script_path = request.args.get("script", "")
    args = request.args.get("args", "")
    exec_id = request.args.get("exec_id", str(time.time()))
    
    if not script_path:
        def err_gen():
            yield f"data: {json.dumps({'type': 'error', 'line': 'No script specified'})}\n\n"
        return Response(err_gen(), mimetype='text/event-stream')
        
    def generate():
        client = None
        channel = None
        try:
            yield f"data: {json.dumps({'type': 'status', 'line': f'Connecting to Pi to run {script_path}...'})}\n\n"
            client = get_ssh_client(timeout=10)
            transport = client.get_transport()
            channel = transport.open_session()
            channel.get_pty()
            
            # Store in active executions for process termination capability
            active_executions[exec_id] = {
                "client": client,
                "channel": channel,
                "script": script_path,
                "running": True
            }
            
            # Unbuffered execution: python3 -u ~/VCT/<script> <args>
            command = f"cd ~/VCT && python3 -u {script_path} {args}"
            yield f"data: {json.dumps({'type': 'status', 'line': f'Executing: {command}'})}\n\n"
            yield f"data: {json.dumps({'type': 'start', 'exec_id': exec_id})}\n\n"
            
            channel.exec_command(command)
            
            # Read output continuously as lines become available
            buffer = ""
            while not channel.exit_status_ready() or channel.recv_ready() or channel.recv_stderr_ready():
                if channel.recv_ready():
                    data = channel.recv(1024).decode('utf-8', errors='ignore')
                    buffer += data
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        yield f"data: {json.dumps({'type': 'log', 'line': line})}\n\n"
                elif channel.recv_stderr_ready():
                    data = channel.recv_stderr(1024).decode('utf-8', errors='ignore')
                    buffer += data
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        yield f"data: {json.dumps({'type': 'stderr', 'line': line})}\n\n"
                else:
                    time.sleep(0.05)
                    
            # Flush remaining buffer
            if buffer:
                yield f"data: {json.dumps({'type': 'log', 'line': buffer})}\n\n"
                
            exit_code = channel.recv_exit_status()
            yield f"data: {json.dumps({'type': 'exit', 'code': exit_code})}\n\n"
            
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'line': f'Execution error: {str(e)}'})}\n\n"
        finally:
            if exec_id in active_executions:
                active_executions[exec_id]["running"] = False
                del active_executions[exec_id]
            if channel:
                try: channel.close()
                except: pass
            if client:
                try: client.close()
                except: pass

    return Response(generate(), mimetype='text/event-stream')

@app.route('/api/run_vct')
def run_vct():
    """SSE endpoint specifically for running vct.py with pre-fed label and duration."""
    label = request.args.get("label", "idling").strip() or "idling"
    duration = request.args.get("duration", "20").strip() or "20"
    exec_id = request.args.get("exec_id", str(time.time()))

    safe_label = label.replace("'", "'\\''")
    safe_dur = duration.replace("'", "'\\''")

    def generate():
        client = None
        channel = None
        try:
            yield f"data: {json.dumps({'type': 'status', 'line': f'Connecting to Pi to run vct.py (Label: {label}, Duration: {duration}s)...'})}\n\n"
            client = get_ssh_client(timeout=10)
            transport = client.get_transport()
            channel = transport.open_session()
            channel.get_pty()
            
            active_executions[exec_id] = {
                "client": client,
                "channel": channel,
                "script": "vct.py",
                "running": True
            }
            
            command = f"cd ~/VCT && printf '{safe_label}\\n{safe_dur}\\n' | python3 -u vct.py"
            yield f"data: {json.dumps({'type': 'status', 'line': f'Executing: {command}'})}\n\n"
            yield f"data: {json.dumps({'type': 'start', 'exec_id': exec_id, 'label': label, 'duration': int(duration)})}\n\n"
            
            channel.exec_command(command)
            
            buffer = ""
            while not channel.exit_status_ready() or channel.recv_ready() or channel.recv_stderr_ready():
                if channel.recv_ready():
                    data = channel.recv(1024).decode('utf-8', errors='ignore')
                    buffer += data
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        yield f"data: {json.dumps({'type': 'log', 'line': line})}\n\n"
                elif channel.recv_stderr_ready():
                    data = channel.recv_stderr(1024).decode('utf-8', errors='ignore')
                    buffer += data
                    while '\n' in buffer:
                        line, buffer = buffer.split('\n', 1)
                        yield f"data: {json.dumps({'type': 'stderr', 'line': line})}\n\n"
                else:
                    time.sleep(0.05)
                    
            if buffer:
                yield f"data: {json.dumps({'type': 'log', 'line': buffer})}\n\n"
                
            exit_code = channel.recv_exit_status()
            yield f"data: {json.dumps({'type': 'exit', 'code': exit_code})}\n\n"
            
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'line': f'Execution error: {str(e)}'})}\n\n"
        finally:
            if exec_id in active_executions:
                active_executions[exec_id]["running"] = False
                del active_executions[exec_id]
            if channel:
                try: channel.close()
                except: pass
            if client:
                try: client.close()
                except: pass

    return Response(generate(), mimetype='text/event-stream')

@app.route('/api/stop_run', methods=['POST'])
def stop_run():
    """Stop/kill a running python script on the Pi."""
    data = request.json or {}
    script_name = data.get("script", "")
    exec_id = data.get("exec_id", "")
    
    try:
        # First close channel if active
        if exec_id in active_executions:
            info = active_executions[exec_id]
            try:
                info["channel"].close()
            except:
                pass
                
        # Also issue SSH kill command on Pi
        client = get_ssh_client()
        if script_name:
            # Kill processes matching python3 and the script name
            cmd = f"pkill -9 -f '{script_name}'"
            client.exec_command(cmd)
        else:
            client.exec_command("pkill -9 -f 'python3 -u'")
            
        client.close()
        
        return jsonify({
            "status": "success",
            "message": f"Stop signal sent for {script_name or 'running scripts'}"
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/api/send_input', methods=['POST'])
def send_input():
    """Send user input to stdin of running SSH Python process."""
    data = request.json or {}
    exec_id = data.get("exec_id", "")
    user_input = data.get("input", "")
    
    target_exec = None
    if exec_id and exec_id in active_executions:
        target_exec = active_executions[exec_id]
    else:
        for eid, info in active_executions.items():
            if info.get("running") and info.get("channel") and not info["channel"].closed:
                target_exec = info
                break
                
    if target_exec:
        channel = target_exec["channel"]
        if channel and not channel.closed:
            channel.send(user_input + "\n")
            return jsonify({
                "status": "success",
                "message": f"Sent input: {user_input}"
            })
            
    return jsonify({
        "status": "error",
        "message": "No active running process to receive input"
    }), 404

if __name__ == '__main__':
    print("==========================================================")
    print("  Raspberry Pi Web Controller & Python Runner Started")
    print("  Access web UI at: http://localhost:5000")
    print("==========================================================")
    app.run(host='0.0.0.0', port=5000, debug=True)
