document.addEventListener('DOMContentLoaded', () => {
    // UI State & References
    let activeEventSource = null;
    let currentExecId = null;
    let statsTimer = null;
    let selectedFileForEdit = null;

    const DOM = {
        // Tabs
        tabBtns: document.querySelectorAll('.tab-btn'),
        tabContents: document.querySelectorAll('.tab-content'),

        // Header Status
        connectionBadge: document.getElementById('connectionBadge'),
        connectionLabel: document.getElementById('connectionLabel'),
        hostPill: document.getElementById('hostPill'),
        btnQuickConnect: document.getElementById('btnQuickConnect'),

        // Runner Controls
        scriptSelect: document.getElementById('scriptSelect'),
        scriptArgs: document.getElementById('scriptArgs'),
        btnRunScript: document.getElementById('btnRunScript'),
        btnStopScript: document.getElementById('btnStopScript'),
        btnRefreshScripts: document.getElementById('btnRefreshScripts'),
        presetPills: document.getElementById('presetPills'),
        
        // Terminal
        terminalOutput: document.getElementById('terminalOutput'),
        runningIndicator: document.getElementById('runningIndicator'),
        chkAutoScroll: document.getElementById('chkAutoScroll'),
        btnClearTerminal: document.getElementById('btnClearTerminal'),
        btnCopyTerminal: document.getElementById('btnCopyTerminal'),
        terminalInput: document.getElementById('terminalInput'),
        btnSendInput: document.getElementById('btnSendInput'),

        // Editor
        fileList: document.getElementById('fileList'),
        btnRefreshFiles: document.getElementById('btnRefreshFiles'),
        editingFileName: document.getElementById('editingFileName'),
        codeTextarea: document.getElementById('codeTextarea'),
        btnSaveFile: document.getElementById('btnSaveFile'),

        // Monitor
        valTemp: document.getElementById('valTemp'),
        valCpu: document.getElementById('valCpu'),
        valRam: document.getElementById('valRam'),
        valRamSub: document.getElementById('valRamSub'),
        valDisk: document.getElementById('valDisk'),
        valDiskSub: document.getElementById('valDiskSub'),
        rawStatsOutput: document.getElementById('rawStatsOutput'),
        btnRefreshStats: document.getElementById('btnRefreshStats'),
        chkAutoRefreshStats: document.getElementById('chkAutoRefreshStats'),

        // VCT Recorder & Countdown UI
        formVctRecorder: document.getElementById('formVctRecorder'),
        vctLabel: document.getElementById('vctLabel'),
        vctDuration: document.getElementById('vctDuration'),
        vctDurationRange: document.getElementById('vctDurationRange'),
        btnStartVctRecording: document.getElementById('btnStartVctRecording'),
        recorderFormCard: document.getElementById('recorderFormCard'),
        countdownCard: document.getElementById('countdownCard'),
        cdLabelTitle: document.getElementById('cdLabelTitle'),
        cdTimeDisplay: document.getElementById('cdTimeDisplay'),
        ringProgress: document.getElementById('ringProgress'),
        btnCancelRecording: document.getElementById('btnCancelRecording'),
        successCard: document.getElementById('successCard'),
        outAudioName: document.getElementById('outAudioName'),
        outVibeName: document.getElementById('outVibeName'),
        btnNewRecording: document.getElementById('btnNewRecording'),
        btnViewFilesInExplorer: document.getElementById('btnViewFilesInExplorer'),
        vctTerminalOutput: document.getElementById('vctTerminalOutput'),
        btnToggleMiniTerminal: document.getElementById('btnToggleMiniTerminal'),
        miniTerminalBody: document.getElementById('miniTerminalBody'),
        miniTermToggleIcon: document.getElementById('miniTermToggleIcon'),

        // Settings Form
        formSshSettings: document.getElementById('formSshSettings'),
        cfgHost: document.getElementById('cfgHost'),
        cfgPort: document.getElementById('cfgPort'),
        cfgUser: document.getElementById('cfgUser'),
        cfgPass: document.getElementById('cfgPass'),
        btnTogglePass: document.getElementById('btnTogglePass')
    };

    // VCT Recorder Timer State
    let vctTimerInterval = null;
    let vctTotalDuration = 20;
    let vctRemainingTime = 20;
    let vctEventSource = null;
    const RING_CIRCUMFERENCE = 534; // 2 * PI * 85

    // --- TOAST MESSAGES ---
    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let iconClass = 'fa-info-circle';
        if (type === 'success') iconClass = 'fa-check-circle';
        if (type === 'error') iconClass = 'fa-exclamation-triangle';

        toast.innerHTML = `<i class="fa-solid ${iconClass}"></i> <span>${message}</span>`;
        container.appendChild(toast);

        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // --- TAB NAVIGATION ---
    DOM.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');

            DOM.tabBtns.forEach(b => b.classList.remove('active'));
            DOM.tabContents.forEach(c => c.classList.remove('active'));

            btn.classList.add('active');
            document.getElementById(targetTab).classList.add('active');

            if (targetTab === 'tab-monitor') {
                fetchSystemInfo();
                startStatsTimer();
            } else {
                stopStatsTimer();
            }
        });
    });

    // --- SSH CONNECTION STATUS ---
    function updateConnectionUI(connected, host = '192.168.8.173') {
        if (connected) {
            DOM.connectionBadge.className = 'status-badge connected';
            DOM.connectionLabel.textContent = 'Connected';
            DOM.hostPill.innerHTML = `<i class="fa-solid fa-server"></i> ${host}`;
        } else {
            DOM.connectionBadge.className = 'status-badge disconnected';
            DOM.connectionLabel.textContent = 'Disconnected';
        }
    }

    async function testConnection(host, port, username, password) {
        try {
            updateConnectionUI(false);
            showToast('Connecting to Raspberry Pi...', 'info');
            
            const res = await fetch('/api/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host, port, username, password })
            });

            const data = await res.json();
            if (data.status === 'success') {
                updateConnectionUI(true, data.host);
                showToast(data.message, 'success');
                loadScriptsAndFiles();
                if (typeof Swal !== 'undefined' && Swal.isVisible()) {
                    Swal.close();
                }
            } else {
                updateConnectionUI(false);
                const msg = data.message || 'Connection failed';
                showToast(msg, 'error');
                showConnectionErrorAlert(msg, host, port, username, password);
            }
        } catch (err) {
            updateConnectionUI(false);
            const msg = 'Failed to connect to backend server';
            showToast(msg, 'error');
            showConnectionErrorAlert(msg, host, port, username, password);
        }
    }

    function showConnectionErrorAlert(message, host, port, username, password) {
        if (typeof Swal === 'undefined') return;

        const isCloudEnv = !['localhost', '127.0.0.1'].includes(window.location.hostname);
        const hostLower = (host || '').toLowerCase();
        const isLocalHostOrIP = hostLower.includes('192.168.') || 
                                hostLower.includes('172.') || 
                                hostLower.includes('10.') || 
                                hostLower.endsWith('.local') || 
                                hostLower === 'localhost';

        // SCENARIO 1: Site hosted on Vercel / Railway trying to reach local IP or .local
        if (isCloudEnv && isLocalHostOrIP) {
            Swal.fire({
                title: '☁️ Vercel / Railway Connection Guide',
                customClass: {
                    popup: 'swal-dark-popup',
                    confirmButton: 'btn-swal-primary',
                    cancelButton: 'btn-swal-secondary'
                },
                icon: 'warning',
                iconColor: '#f59e0b',
                html: `
                    <div style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main);">
                        <p style="margin-bottom: 10px;">
                            <strong>Why did connection to <code>${host}</code> fail?</strong><br>
                            Your app is running in the cloud (<strong>Vercel / Railway</strong>), but <code>${host}</code> is a private local IP hidden behind your home router firewall.
                        </p>

                        <div class="swal-guide-box">
                            <div class="swal-guide-title"><i class="fa-solid fa-bolt"></i> Quick Solution (Connect Pi to Cloud):</div>
                            <div class="swal-step">
                                <strong>1. Run this tunnel on your Raspberry Pi terminal:</strong><br>
                                <code class="swal-code-badge">ngrok tcp 22</code>
                                <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">
                                    <em>(Or no installation: <code class="swal-code-badge">ssh -R 0:localhost:22 a.pinggy.io</code>)</em>
                                </div>
                            </div>
                            <div class="swal-step" style="margin-top: 8px;">
                                <strong>2. Paste the generated public Host & Port below:</strong>
                            </div>
                            <div class="swal-input-group">
                                <input type="text" id="swalPublicHost" class="swal-input-field" placeholder="Host (e.g. 4.tcp.ngrok.io)">
                                <input type="number" id="swalPublicPort" class="swal-input-field" placeholder="Port (e.g. 14532)" style="width: 130px !important;">
                            </div>
                        </div>
                    </div>
                `,
                showCancelButton: true,
                confirmButtonText: '<i class="fa-solid fa-plug"></i> Save & Connect SSH',
                cancelButtonText: 'Dismiss',
                focusConfirm: false,
                preConfirm: () => {
                    const newHost = document.getElementById('swalPublicHost').value.trim();
                    const newPort = document.getElementById('swalPublicPort').value.trim();
                    if (!newHost || !newPort) {
                        Swal.showValidationMessage('Please enter both public Host and Port!');
                        return false;
                    }
                    return { newHost, newPort };
                }
            }).then((result) => {
                if (result.isConfirmed && result.value) {
                    const { newHost, newPort } = result.value;
                    DOM.cfgHost.value = newHost;
                    DOM.cfgPort.value = newPort;
                    testConnection(newHost, newPort, username, password);
                }
            });
            return;
        }

        // SCENARIO 2: Authentication Error (Password Mismatch)
        if (message.toLowerCase().includes('authentication failed') || message.toLowerCase().includes('invalid password')) {
            Swal.fire({
                title: '🔑 SSH Authentication Failed',
                customClass: {
                    popup: 'swal-dark-popup',
                    confirmButton: 'btn-swal-primary',
                    cancelButton: 'btn-swal-secondary'
                },
                icon: 'error',
                html: `
                    <div style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main);">
                        <p style="margin-bottom: 10px;">Connected to <code>${host}:${port}</code>, but the login was rejected.</p>
                        <div class="swal-guide-box">
                            <div class="swal-step"><strong>Username:</strong> <code>${username}</code></div>
                            <div class="swal-step"><strong>Password:</strong> Please check password (default: <code>vct@43</code>).</div>
                        </div>
                    </div>
                `,
                confirmButtonText: 'Adjust SSH Settings',
                showCancelButton: true,
                cancelButtonText: 'Close'
            }).then((res) => {
                if (res.isConfirmed) {
                    const settingsBtn = document.querySelector('[data-tab="tab-settings"]');
                    if (settingsBtn) settingsBtn.click();
                }
            });
            return;
        }

        // SCENARIO 3: ~/VCT Directory Missing
        if (message.includes('~/VCT directory was not found')) {
            Swal.fire({
                title: '📁 ~/VCT Directory Missing',
                customClass: {
                    popup: 'swal-dark-popup',
                    confirmButton: 'btn-swal-primary',
                    cancelButton: 'btn-swal-secondary'
                },
                icon: 'warning',
                iconColor: '#f59e0b',
                html: `
                    <div style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main);">
                        <p>SSH connected successfully, but directory <code>/home/${username}/VCT</code> was not found on your Pi!</p>
                        <div class="swal-guide-box">
                            <div class="swal-step">Run this command on your Raspberry Pi terminal to create it:</div>
                            <code class="swal-code-badge">mkdir -p ~/VCT</code>
                        </div>
                    </div>
                `,
                confirmButtonText: 'Try Again',
                showCancelButton: true,
                cancelButtonText: 'Close'
            }).then((res) => {
                if (res.isConfirmed) {
                    testConnection(host, port, username, password);
                }
            });
            return;
        }

        // SCENARIO 4: General Timeout or Network Error
        Swal.fire({
            title: '📡 Raspberry Pi Connection Error',
            customClass: {
                popup: 'swal-dark-popup',
                confirmButton: 'btn-swal-primary',
                cancelButton: 'btn-swal-secondary'
            },
            icon: 'error',
            html: `
                <div style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main);">
                    <p style="margin-bottom: 10px;"><strong>Message:</strong> <code>${message}</code></p>
                    <div class="swal-guide-box">
                        <div class="swal-guide-title"><i class="fa-solid fa-circle-question"></i> Troubleshooting Checklist:</div>
                        <div class="swal-step">1. Ensure Raspberry Pi is powered ON and connected to Wi-Fi.</div>
                        <div class="swal-step">2. Check SSH status on Pi: <code>sudo systemctl status ssh</code>.</div>
                        <div class="swal-step">3. If running locally, confirm PC and Pi are on the same Wi-Fi.</div>
                    </div>
                </div>
            `,
            confirmButtonText: 'Open SSH Settings',
            showCancelButton: true,
            cancelButtonText: 'Close'
        }).then((res) => {
            if (res.isConfirmed) {
                const settingsBtn = document.querySelector('[data-tab="tab-settings"]');
                if (settingsBtn) settingsBtn.click();
            }
        });
    }

    // Quick Connect Button
    DOM.btnQuickConnect.addEventListener('click', () => {
        testConnection(DOM.cfgHost.value, DOM.cfgPort.value, DOM.cfgUser.value, DOM.cfgPass.value);
    });

    // Form Submit
    DOM.formSshSettings.addEventListener('submit', (e) => {
        e.preventDefault();
        testConnection(DOM.cfgHost.value, DOM.cfgPort.value, DOM.cfgUser.value, DOM.cfgPass.value);
    });

    // Toggle Password Visibility
    DOM.btnTogglePass.addEventListener('click', () => {
        const type = DOM.cfgPass.type === 'password' ? 'text' : 'password';
        DOM.cfgPass.type = type;
        DOM.btnTogglePass.innerHTML = type === 'password' ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
    });

    // --- SCRIPT & FILE LISTING ---
    async function loadScriptsAndFiles() {
        try {
            const res = await fetch('/api/scripts');
            const data = await res.json();

            if (data.status !== 'success') {
                showToast(data.message || 'Failed to list files', 'error');
                return;
            }

            const items = data.items || [];
            
            // Filter Python scripts
            const pyFiles = items.filter(i => i.is_python);

            // Populate Dropdown
            DOM.scriptSelect.innerHTML = pyFiles.length > 0 
                ? pyFiles.map(f => `<option value="${f.name}">${f.name}</option>`).join('')
                : '<option value="">-- No .py scripts found in ~/VCT --</option>';

            // Populate Presets Pills
            DOM.presetPills.innerHTML = pyFiles.length > 0
                ? pyFiles.map(f => `<span class="script-pill" data-script="${f.name}"><i class="fa-brands fa-python"></i> ${f.name}</span>`).join('')
                : '<span class="text-muted">No scripts found</span>';

            // Add Click listeners to pills
            document.querySelectorAll('.script-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    const scriptName = pill.getAttribute('data-script');
                    DOM.scriptSelect.value = scriptName;
                    showToast(`Selected ${scriptName}`, 'info');
                });
            });

            // Populate File Explorer Sidebar
            renderFileTree(items);

        } catch (err) {
            console.error(err);
            showToast('Error fetching script files from Pi', 'error');
        }
    }

    function renderFileTree(items) {
        if (!items || items.length === 0) {
            DOM.fileList.innerHTML = '<div class="text-muted" style="padding: 10px;">Empty folder</div>';
            return;
        }

        DOM.fileList.innerHTML = items.map(item => {
            let iconClass = 'fa-file file-item-icon file';
            if (item.is_dir) iconClass = 'fa-folder file-item-icon folder';
            else if (item.is_python) iconClass = 'fa-brands fa-python file-item-icon py';

            const formattedSize = item.is_dir ? 'DIR' : `${(item.size / 1024).toFixed(1)} KB`;

            return `
                <div class="file-item" data-path="${item.path}" data-isdir="${item.is_dir}">
                    <div class="file-item-left">
                        <i class="fa-solid ${iconClass}"></i>
                        <span class="file-item-name">${item.name}</span>
                    </div>
                    <span class="file-item-size">${formattedSize}</span>
                </div>
            `;
        }).join('');

        // Attach click events for file editor
        document.querySelectorAll('.file-item').forEach(el => {
            el.addEventListener('click', () => {
                const isDir = el.getAttribute('data-isdir') === 'true';
                const path = el.getAttribute('data-path');

                if (isDir) {
                    showToast('Subdirectory browsing', 'info');
                    return;
                }

                document.querySelectorAll('.file-item').forEach(f => f.classList.remove('active'));
                el.classList.add('active');

                loadFileContent(path);
            });
        });
    }

    DOM.btnRefreshScripts.addEventListener('click', loadScriptsAndFiles);
    DOM.btnRefreshFiles.addEventListener('click', loadScriptsAndFiles);

    // --- CODE EDITOR ---
    async function loadFileContent(filePath) {
        try {
            selectedFileForEdit = filePath;
            DOM.editingFileName.textContent = filePath;
            DOM.codeTextarea.value = 'Loading file content from Pi...';
            DOM.codeTextarea.readOnly = true;
            DOM.btnSaveFile.disabled = true;

            const res = await fetch(`/api/file/read?path=${encodeURIComponent(filePath)}`);
            const data = await res.json();

            if (data.status === 'success') {
                DOM.codeTextarea.value = data.content;
                DOM.codeTextarea.readOnly = false;
                DOM.btnSaveFile.disabled = false;
            } else {
                DOM.codeTextarea.value = `Error loading file: ${data.message}`;
                showToast(data.message, 'error');
            }
        } catch (err) {
            DOM.codeTextarea.value = `Failed to connect to backend server.`;
            showToast('Failed to read file from Pi', 'error');
        }
    }

    DOM.btnSaveFile.addEventListener('click', async () => {
        if (!selectedFileForEdit) return;

        try {
            DOM.btnSaveFile.disabled = true;
            DOM.btnSaveFile.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';

            const res = await fetch('/api/file/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: selectedFileForEdit,
                    content: DOM.codeTextarea.value
                })
            });

            const data = await res.json();
            if (data.status === 'success') {
                showToast(`Saved ${selectedFileForEdit} successfully`, 'success');
            } else {
                showToast(data.message || 'Error saving file', 'error');
            }
        } catch (err) {
            showToast('Save request failed', 'error');
        } finally {
            DOM.btnSaveFile.disabled = false;
            DOM.btnSaveFile.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to Pi';
        }
    });

    // --- TERMINAL & SCRIPT EXECUTION ---
    function appendLogLine(text, type = 'log') {
        const lineEl = document.createElement('div');
        lineEl.className = `term-line term-${type}`;
        
        const timestamp = new Date().toLocaleTimeString();
        lineEl.textContent = `[${timestamp}] ${text}`;
        
        DOM.terminalOutput.appendChild(lineEl);

        if (DOM.chkAutoScroll.checked) {
            DOM.terminalOutput.scrollTop = DOM.terminalOutput.scrollHeight;
        }
    }

    DOM.btnClearTerminal.addEventListener('click', () => {
        DOM.terminalOutput.innerHTML = '';
        appendLogLine('Console cleared.', 'sys');
    });

    DOM.btnCopyTerminal.addEventListener('click', () => {
        const text = DOM.terminalOutput.innerText;
        navigator.clipboard.writeText(text).then(() => {
            showToast('Log copied to clipboard', 'success');
        });
    });

    // Run Script
    DOM.btnRunScript.addEventListener('click', () => {
        const script = DOM.scriptSelect.value;
        const args = DOM.scriptArgs.value.trim();

        if (!script) {
            showToast('Please select a Python script to run!', 'error');
            return;
        }

        if (activeEventSource) {
            activeEventSource.close();
        }

        currentExecId = 'exec_' + Date.now();
        DOM.runningIndicator.style.display = 'inline-flex';
        DOM.btnRunScript.disabled = true;
        DOM.btnStopScript.disabled = false;
        DOM.terminalInput.disabled = false;
        DOM.btnSendInput.disabled = false;
        DOM.terminalInput.focus();

        appendLogLine(`=== Launching ${script} ===`, 'sys');

        const sseUrl = `/api/stream_run?script=${encodeURIComponent(script)}&args=${encodeURIComponent(args)}&exec_id=${currentExecId}`;
        activeEventSource = new EventSource(sseUrl);

        activeEventSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);

                if (data.type === 'status') {
                    appendLogLine(data.line, 'sys');
                } else if (data.type === 'log') {
                    appendLogLine(data.line, 'log');
                } else if (data.type === 'stderr') {
                    appendLogLine(data.line, 'err');
                } else if (data.type === 'exit') {
                    appendLogLine(`Process finished with exit code ${data.code}`, data.code === 0 ? 'sys' : 'warn');
                    stopExecutionUI();
                } else if (data.type === 'error') {
                    appendLogLine(`Execution error: ${data.line}`, 'err');
                    stopExecutionUI();
                }
            } catch (err) {
                appendLogLine(e.data, 'log');
            }
        };

        activeEventSource.onerror = (err) => {
            appendLogLine('EventSource connection closed.', 'warn');
            stopExecutionUI();
        };
    });

    // Send Input to Terminal Process
    async function sendTerminalInput(presetVal) {
        const valToSend = presetVal !== undefined ? presetVal : DOM.terminalInput.value.trim();
        if (valToSend === '') return;

        appendLogLine(`> ${valToSend}`, 'in');

        try {
            const res = await fetch('/api/send_input', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ exec_id: currentExecId, input: valToSend })
            });

            const data = await res.json();
            if (data.status !== 'success') {
                showToast(data.message || 'Failed to send input', 'error');
            }
        } catch (err) {
            showToast('Failed to send input to script', 'error');
        }

        DOM.terminalInput.value = '';
    }

    DOM.btnSendInput.addEventListener('click', () => sendTerminalInput());
    DOM.terminalInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendTerminalInput();
        }
    });

    // Quick Answer buttons
    document.querySelectorAll('.btn-quick-ans').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.getAttribute('data-input');
            sendTerminalInput(val);
        });
    });

    // Stop Script
    DOM.btnStopScript.addEventListener('click', async () => {
        const script = DOM.scriptSelect.value;
        showToast('Sending stop signal to Pi...', 'info');

        try {
            await fetch('/api/stop_run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ script: script, exec_id: currentExecId })
            });

            appendLogLine('Stop signal sent to running script.', 'warn');
        } catch (err) {
            showToast('Failed to send stop command', 'error');
        } finally {
            stopExecutionUI();
        }
    });

    function stopExecutionUI() {
        if (activeEventSource) {
            activeEventSource.close();
            activeEventSource = null;
        }
        DOM.runningIndicator.style.display = 'none';
        DOM.btnRunScript.disabled = false;
        DOM.btnStopScript.disabled = true;
        DOM.terminalInput.disabled = true;
        DOM.btnSendInput.disabled = true;
    }

    // --- PI SYSTEM MONITOR ---
    async function fetchSystemInfo() {
        try {
            const res = await fetch('/api/system_info');
            const data = await res.json();

            if (data.status === 'success') {
                DOM.valTemp.textContent = data.temp || 'N/A';
                DOM.valCpu.textContent = data.cpu || '0%';
                
                DOM.valRam.textContent = `${data.memory.percent}%`;
                DOM.valRamSub.textContent = `${data.memory.used} / ${data.memory.total}`;

                DOM.valDisk.textContent = `${data.disk.percent}%`;
                DOM.valDiskSub.textContent = `${data.disk.used} / ${data.disk.total}`;

                DOM.rawStatsOutput.textContent = data.raw;
            }
        } catch (err) {
            console.error('Error fetching Pi system metrics', err);
        }
    }

    DOM.btnRefreshStats.addEventListener('click', fetchSystemInfo);

    function startStatsTimer() {
        if (statsTimer) clearInterval(statsTimer);
        statsTimer = setInterval(() => {
            if (DOM.chkAutoRefreshStats.checked) {
                fetchSystemInfo();
            }
        }, 5000);
    }

    function stopStatsTimer() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
    }

    // --- DEDICATED VCT FUSION RECORDER & ANIMATED COUNTDOWN LOGIC ---

    // Quick Label Chips
    document.querySelectorAll('.btn-chip').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-chip').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            DOM.vctLabel.value = btn.getAttribute('data-val');
        });
    });

    // Quick Duration Chips
    document.querySelectorAll('.btn-chip-dur').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-chip-dur').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const val = parseInt(btn.getAttribute('data-val'));
            DOM.vctDuration.value = val;
            DOM.vctDurationRange.value = val;
        });
    });

    // Duration range slider sync
    DOM.vctDurationRange.addEventListener('input', (e) => {
        DOM.vctDuration.value = e.target.value;
    });
    DOM.vctDuration.addEventListener('input', (e) => {
        DOM.vctDurationRange.value = e.target.value;
    });

    // Mini Terminal Drawer Toggle
    DOM.btnToggleMiniTerminal.addEventListener('click', () => {
        const isHidden = DOM.miniTerminalBody.style.display === 'none';
        DOM.miniTerminalBody.style.display = isHidden ? 'block' : 'none';
        DOM.miniTermToggleIcon.classList.toggle('open', isHidden);
    });

    function appendVctLog(text, type = 'log') {
        const lineEl = document.createElement('div');
        lineEl.className = `term-line term-${type}`;
        const timestamp = new Date().toLocaleTimeString();
        lineEl.textContent = `[${timestamp}] ${text}`;
        DOM.vctTerminalOutput.appendChild(lineEl);
        DOM.vctTerminalOutput.scrollTop = DOM.vctTerminalOutput.scrollHeight;
    }

    // Start VCT Fusion Recording Form Submit
    DOM.formVctRecorder.addEventListener('submit', (e) => {
        e.preventDefault();

        const label = DOM.vctLabel.value.trim() || 'test';
        const duration = parseInt(DOM.vctDuration.value) || 20;

        vctTotalDuration = duration;
        vctRemainingTime = duration;

        // UI Transition to Countdown Dashboard
        DOM.recorderFormCard.style.display = 'none';
        DOM.successCard.style.display = 'none';
        DOM.countdownCard.style.display = 'block';
        DOM.cdLabelTitle.textContent = `Recording: ${label}`;
        DOM.cdTimeDisplay.textContent = vctRemainingTime;
        DOM.ringProgress.style.strokeDashoffset = '0';

        DOM.vctTerminalOutput.innerHTML = '';
        appendVctLog(`=== Starting VCT Fusion Recording (Label: ${label}, Duration: ${duration}s) ===`, 'sys');

        // Start SSE Stream to /api/run_vct
        const execId = 'vct_' + Date.now();
        const url = `/api/run_vct?label=${encodeURIComponent(label)}&duration=${duration}&exec_id=${execId}`;
        vctEventSource = new EventSource(url);

        let audioPath = `vehicle_data/data_${label}.wav`;
        let vibePath = `vehicle_data/data_${label}.csv`;

        vctEventSource.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);

                if (data.type === 'log') {
                    appendVctLog(data.line, 'log');

                    // Parse output audio/vibe file paths if present
                    if (data.line.includes('1. Audio:')) {
                        audioPath = data.line.split('1. Audio:')[1].trim();
                    }
                    if (data.line.includes('2. Vibration:')) {
                        vibePath = data.line.split('2. Vibration:')[1].trim();
                    }
                } else if (data.type === 'stderr') {
                    appendVctLog(data.line, 'err');
                } else if (data.type === 'status') {
                    appendVctLog(data.line, 'sys');
                } else if (data.type === 'exit') {
                    appendVctLog(`vct.py finished execution (exit code ${data.code})`, 'sys');
                    finishVctRecording(true, audioPath, vibePath);
                } else if (data.type === 'error') {
                    appendVctLog(`Execution error: ${data.line}`, 'err');
                    finishVctRecording(false);
                }
            } catch (err) {
                appendVctLog(evt.data, 'log');
            }
        };

        vctEventSource.onerror = () => {
            finishVctRecording(true, audioPath, vibePath);
        };

        // Start Animated Ring Timer
        if (vctTimerInterval) clearInterval(vctTimerInterval);
        vctTimerInterval = setInterval(() => {
            vctRemainingTime--;

            if (vctRemainingTime < 0) {
                vctRemainingTime = 0;
            }

            DOM.cdTimeDisplay.textContent = vctRemainingTime;

            // Calculate Circular Ring Progress
            const pct = vctRemainingTime / vctTotalDuration;
            const offset = RING_CIRCUMFERENCE * (1 - pct);
            DOM.ringProgress.style.strokeDashoffset = offset;

            if (vctRemainingTime <= 0) {
                clearInterval(vctTimerInterval);
            }
        }, 1000);
    });

    // Emergency Stop / Cancel
    DOM.btnCancelRecording.addEventListener('click', async () => {
        showToast('Stopping recording on Pi...', 'info');
        try {
            await fetch('/api/stop_run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ script: 'vct.py' })
            });
        } catch (err) {}

        finishVctRecording(false);
    });

    function finishVctRecording(success = true, audioPath = '', vibePath = '') {
        if (vctTimerInterval) {
            clearInterval(vctTimerInterval);
            vctTimerInterval = null;
        }
        if (vctEventSource) {
            vctEventSource.close();
            vctEventSource = null;
        }

        DOM.countdownCard.style.display = 'none';

        if (success) {
            DOM.successCard.style.display = 'block';
            DOM.outAudioName.textContent = audioPath || 'vehicle_data/audio.wav';
            DOM.outVibeName.textContent = vibePath || 'vehicle_data/vibration.csv';
            showToast('Fusion Capture Complete!', 'success');
        } else {
            DOM.recorderFormCard.style.display = 'block';
            showToast('Recording cancelled or interrupted', 'error');
        }
    }

    // Start New Recording Button
    DOM.btnNewRecording.addEventListener('click', () => {
        DOM.successCard.style.display = 'none';
        DOM.recorderFormCard.style.display = 'block';
    });

    // Browse Files in Code Editor / Explorer
    DOM.btnViewFilesInExplorer.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        const editorBtn = document.querySelector('[data-tab="tab-editor"]');
        if (editorBtn) editorBtn.classList.add('active');
        document.getElementById('tab-editor').classList.add('active');
        loadScriptsAndFiles();
    });

    // INITIALIZATION: Auto-connect on page load
    testConnection(DOM.cfgHost.value, DOM.cfgPort.value, DOM.cfgUser.value, DOM.cfgPass.value);
});
