/* ============================================================
   Controle Universal IR - painel web (GitHub Pages)
   Conecta direto ao EMQX Cloud por WebSocket TLS e conversa
   com o ESP32 pelos tópicos MQTT.
   ============================================================ */

(() => {
  'use strict';

  const STORAGE_KEY = 'esp32-ir-remote-settings-v1';

  const DEFAULTS = {
    url: 'wss://vc7120c8.ala.us-east-1.emqxsl.com:8084/mqtt',
    username: 'Esp32_jp',
    password: 'senhaesp1234',
    root: 'Topic_espjp',
    env: 'sala01',
    remember: true,
  };

  const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  const AC_MODE_LABELS = {
    cool: 'Frio',
    heat: 'Quente',
    dry: 'Seco',
    fan: 'Ventilar',
    auto: 'Automático',
  };

  const AC_FAN_LABELS = {
    auto: 'Ventoinha automática',
    min: 'Ventoinha mínima',
    low: 'Ventoinha baixa',
    medium: 'Ventoinha média',
    high: 'Ventoinha alta',
  };

  const AC_SWING_LABELS = {
    off: 'Swing desligado',
    on: 'Swing oscilando',
    highest: 'Swing no máximo',
    high: 'Swing alto',
    middle: 'Swing no centro',
    low: 'Swing baixo',
    lowest: 'Swing no mínimo',
  };

  // Funções do controle universal. Cada uma aponta para um comando raw
  // aprendido; funciona com qualquer modelo de ar-condicionado.
  const AC_ROLES = [
    { key: 'power_on', label: 'Ligar', primary: true },
    { key: 'power_off', label: 'Desligar', primary: true },
    { key: 'power_toggle', label: 'Alternar' },
    { key: 'temp_up', label: 'Temp +' },
    { key: 'temp_down', label: 'Temp −' },
    { key: 'mode', label: 'Modo' },
    { key: 'fan', label: 'Ventoinha' },
    { key: 'swing', label: 'Swing' },
    { key: 'timer', label: 'Timer' },
    { key: 'sleep', label: 'Sleep' },
    { key: 'turbo', label: 'Turbo' },
    { key: 'light', label: 'Luz' },
  ];

  const AC_ROLE_LABELS = Object.fromEntries(
    AC_ROLES.map((role) => [role.key, role.label])
  );

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const S = {
    client: null,
    connected: false,
    settings: loadSettings(),
    base: '',
    commands: [],
    schedules: [],
    status: null,
    pending: new Map(),
    learn: null,
    learnTimer: null,
    backup: null,
    restoring: false,
    lastLearned: [],
    logLines: [],
    ac: {
      power: false,
      mode: 'cool',
      temp: 24,
      fan: 'auto',
      swing: 'off',
      turbo: false,
      quiet: false,
      econo: false,
      light: false,
      health: false,
    },
    acMap: {},
    acBusy: false,
    learnRole: null,
  };

  /* ---------------- utilidades ---------------- */

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function setText(sel, value) {
    const el = $(sel);
    if (el) el.textContent = value ?? '—';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(message) {
    const time = new Date().toLocaleTimeString('pt-BR');
    S.logLines.push(`[${time}] ${message}`);
    if (S.logLines.length > 500) S.logLines.shift();

    const box = $('#logBox');
    if (box) {
      box.textContent = S.logLines.join('\n');
      box.scrollTop = box.scrollHeight;
    }
  }

  function toast(message, kind = 'info', ms = 4600) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  function normalizeName(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[ .\/]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24);
  }

  function validName(name) {
    return /^[a-z0-9_-]{1,24}$/.test(name);
  }

  function rssiText(rssi) {
    if (typeof rssi !== 'number') return 'sinal —';
    let quality = 'ruim';
    if (rssi >= -60) quality = 'ótimo';
    else if (rssi >= -70) quality = 'bom';
    else if (rssi >= -80) quality = 'fraco';
    return `${rssi} dBm (${quality})`;
  }

  function fmtUptime(seconds) {
    if (typeof seconds !== 'number' || seconds < 0) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}min`;
    if (m) return `${m}min ${s}s`;
    return `${s}s`;
  }

  function daysLabel(mask) {
    const days = DAY_NAMES.filter((_, i) => mask & (1 << i));
    return days.length === 7 ? 'todos os dias' : days.join(', ') || 'nenhum dia';
  }

  function fmtTime(hour, minute) {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function fileStamp() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ---------------- configurações ---------------- */

  function loadSettings() {
    const merged = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const key of ['url', 'username', 'root', 'env']) {
        if (typeof saved[key] === 'string' && saved[key]) merged[key] = saved[key];
      }
      merged.remember = saved.remember !== false;
      if (merged.remember && typeof saved.password === 'string') {
        merged.password = saved.password;
      } else {
        merged.password = DEFAULTS.password;
      }
    } catch (e) {
      // localStorage indisponível: segue com os padrões
    }
    return merged;
  }

  function saveSettings() {
    const copy = { ...S.settings };
    if (!copy.remember) copy.password = '';
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
    } catch (e) {
      // ignora
    }
  }

  function fillForm() {
    $('#inUrl').value = S.settings.url;
    $('#inUser').value = S.settings.username;
    $('#inPass').value = S.settings.password;
    $('#inRoot').value = S.settings.root;
    $('#inEnv').value = S.settings.env;
    $('#inRemember').checked = S.settings.remember;
    updatePreview();
  }

  function readForm() {
    S.settings.url = $('#inUrl').value.trim();
    S.settings.username = $('#inUser').value.trim();
    S.settings.password = $('#inPass').value;
    S.settings.root = $('#inRoot').value.trim().replace(/\/+$/, '');
    S.settings.env = $('#inEnv').value.trim().replace(/^\/+|\/+$/g, '');
    S.settings.remember = $('#inRemember').checked;
    updatePreview();
    saveSettings();
  }

  function updatePreview() {
    const root = ($('#inRoot').value || '').trim().replace(/\/+$/, '');
    const env = ($('#inEnv').value || '').trim().replace(/^\/+|\/+$/g, '');
    const base = root && env ? `${root}/${env}` : '—';
    setText('#topicPreview', base);
    setText('#footTopic', base === '—' ? '—' : `${base}/comando`);
    setText('#envLabel', env || '—');
  }

  /* ---------------- conexão MQTT ---------------- */

  function setConnState(state, text) {
    const pill = $('#connPill');
    pill.classList.remove('online', 'connecting', 'error');
    if (state) pill.classList.add(state);
    setText('#connText', text);
  }

  function setConnected(connected) {
    S.connected = connected;
    $('#btnConnect').disabled = connected;
    $('#btnDisconnect').disabled = !connected;

    if (connected) {
      setConnState('online', 'Conectado');
    } else {
      setConnState('error', 'Desconectado');
      failPending('Conexão encerrada.');
    }
  }

  function setConnecting() {
    setConnState('connecting', 'Conectando…');
  }

  function failPending(message) {
    for (const [, pending] of S.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    S.pending.clear();
  }

  function connect() {
    if (typeof mqtt === 'undefined') {
      toast('Biblioteca MQTT não carregou. Verifique a internet/CDN.', 'error', 7000);
      setConnState('error', 'Desconectado');
      return;
    }

    if (S.client) {
      try { S.client.end(true); } catch (e) { /* ignora */ }
      S.client = null;
    }

    readForm();

    if (!S.settings.url || !S.settings.env || !S.settings.root) {
      toast('Preencha broker, tópico raiz e ambiente.', 'warn');
      return;
    }

    S.base = `${S.settings.root}/${S.settings.env}`;
    const clientId = `web_${S.settings.env}_${Math.random().toString(16).slice(2, 10)}`;

    setConnecting();
    log(`Conectando em ${S.settings.url} como ${clientId}`);

    const client = mqtt.connect(S.settings.url, {
      username: S.settings.username,
      password: S.settings.password,
      clientId,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 12000,
      keepalive: 30,
      protocolVersion: 4,
    });

    S.client = client;

    client.on('connect', () => {
      setConnected(true);
      log(`MQTT conectado. Base: ${S.base}`);

      const topics = [
        `${S.base}/status`,
        `${S.base}/resposta`,
        `${S.base}/dados`,
      ];

      client.subscribe(topics, { qos: 1 }, (err) => {
        if (err) {
          toast('Falha ao assinar os tópicos MQTT.', 'error');
          log(`Subscribe falhou: ${err.message}`);
          return;
        }
        log(`Inscrito em ${topics.join(', ')}`);
        setTimeout(refreshAll, 400);
      });
    });

    client.on('message', onMessage);

    client.on('error', (err) => {
      log(`Erro MQTT: ${err.message}`);
    });

    client.on('reconnect', () => {
      if (!S.connected) setConnecting();
      log('Reconectando ao broker…');
    });

    client.on('close', () => {
      if (S.connected) log('Conexão MQTT fechada.');
      setConnected(false);
    });

    client.on('offline', () => {
      setConnState('error', 'Offline');
    });
  }

  function disconnect() {
    if (S.client) {
      try { S.client.end(true); } catch (e) { /* ignora */ }
      S.client = null;
    }
    S.connected = false;
    setConnected(false);
    setConnState('', 'Desconectado');
    log('Desconectado pelo usuário.');
  }

  function onMessage(topic, payload) {
    let data;
    try {
      data = JSON.parse(payload.toString());
    } catch (e) {
      log(`Payload inválido em ${topic}`);
      return;
    }

    if (topic === `${S.base}/status`) onStatus(data);
    else if (topic === `${S.base}/resposta`) onReply(data);
    else if (topic === `${S.base}/dados`) onEvent(data);
  }

  function onStatus(status) {
    S.status = status;
    renderStatus();
  }

  function onReply(reply) {
    const pending = S.pending.get(reply.id);
    const action = reply.action || pending?.action || '?';

    if (reply.ok) log(`← ${action}: ok`);
    else log(`← ${action}: erro (${reply.error || 'sem detalhe'})`);

    if (!pending) return;

    clearTimeout(pending.timer);
    S.pending.delete(reply.id);

    if (reply.ok) pending.resolve(reply);
    else pending.reject(new Error(reply.error || `Falha em ${action}.`));
  }

  function onEvent(event) {
    switch (event.type) {
      case 'mqtt_connected':
        log('ESP32 confirmou conexão MQTT.');
        break;

      case 'learn_started':
        log(`Aprendizado iniciado: ${event.name || ''}`);
        break;

      case 'learned': {
        log(`Aprendido ${event.name}: ${event.pulses} pulsos, ${event.freq} kHz, ${event.proto || 'RAW'}`);
        stopLearnUI();
        addLastLearned(event);
        toast(`Comando "${event.name}" aprendido.`, 'ok');
        refreshCommands();

        const role = S.learnRole;
        S.learnRole = null;
        if (role) {
          const next = { ...S.acMap, [role]: event.name };
          saveAcMap(next, `"${event.name}" atribuído a ${AC_ROLE_LABELS[role] || role}.`);
        }
        break;
      }

      case 'learn_warning':
        setText('#learnHint', `Sinal ignorado (${event.reason || 'inválido'}). Tente novamente.`);
        log(`Aviso de aprendizado: ${event.reason || 'sinal inválido'}`);
        break;

      case 'learn_timeout':
        log(`Tempo esgotado ao aprender ${event.name || ''}.`);
        stopLearnUI();
        if (S.learnRole) {
          setText('#acMapStatus', 'Tempo esgotado; nada foi atribuído.');
          S.learnRole = null;
        }
        toast('Tempo esgotado. Nenhum sinal foi aprendido.', 'warn');
        break;

      case 'learn_cancelled':
        stopLearnUI();
        if (S.learnRole) {
          setText('#acMapStatus', 'Aprendizado cancelado.');
          S.learnRole = null;
        }
        log('Aprendizado cancelado.');
        break;

      case 'command_sent':
        log('Comando transmitido.');
        break;

      case 'command_failed':
        log('Falha ao transmitir comando.');
        break;

      case 'ac_sent':
        log('Ar-condicionado: quadro TCL112AC enviado.');
        break;

      case 'ac_failed':
        log('Falha ao enviar o ar-condicionado.');
        break;

      case 'ac_map_saved':
        log('Mapa de funções do ar salvo.');
        break;

      case 'command_deleted':
        log('Comando apagado.');
        break;

      case 'command_renamed':
        log('Comando renomeado.');
        break;

      case 'command_restored':
        log('Comando restaurado.');
        break;

      case 'schedule_fired':
        toast(`Agenda executou "${event.name}"${event.ok ? '' : ' (falhou)'}.`,
              event.ok ? 'ok' : 'warn');
        log(`Agenda disparou ${event.name} (id ${event.id}).`);
        break;

      case 'schedule_saved':
      case 'schedule_deleted':
      case 'schedule_toggled':
        refreshSchedules();
        break;

      case 'backup_begin':
        if (S.backup) {
          S.backup.expected = Number(event.count) || 0;
          setBackupBusy(true, `Recebendo comandos (0/${S.backup.expected})...`, 0);
        }
        log(`Backup iniciado: ${event.count} comando(s).`);
        break;

      case 'backup_item':
        if (!S.backup) break;
        S.backup.items.push({
          name: event.name,
          freq: event.freq,
          proto: event.proto,
          bits: event.bits,
          pulses: event.pulses,
          raw: event.raw,
        });
        {
          const total = S.backup.expected || S.backup.items.length;
          const pct = total ? Math.min(95, (S.backup.items.length / total) * 90) : 10;
          setBackupBusy(true,
            `Recebendo comandos (${S.backup.items.length}/${S.backup.expected || '?'})...`,
            pct);
        }
        break;

      case 'backup_end':
        if (!S.backup) break;
        S.backup.backupDone = true;
        log(`Backup recebido: ${event.count} comando(s).`);
        S.backup.maybeFinish();
        break;

      default:
        log(`Evento: ${event.type}`);
    }
  }

  /* ---------------- pedidos ---------------- */

  function request(action, data = {}, timeout = 12000) {
    if (!S.connected || !S.client) {
      return Promise.reject(new Error('Conecte-se ao broker primeiro.'));
    }

    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        S.pending.delete(id);
        reject(new Error(`Tempo esgotado sem resposta (${action}).`));
      }, timeout);

      S.pending.set(id, { resolve, reject, timer, action });

      try {
        S.client.publish(
          `${S.base}/comando`,
          JSON.stringify({ ...data, id, action }),
          { qos: 1 },
          (err) => {
            if (err) log(`Falha ao publicar ${action}: ${err.message}`);
          }
        );
        log(`→ ${action}`);
      } catch (e) {
        clearTimeout(timer);
        S.pending.delete(id);
        reject(e);
      }
    });
  }

  /* ---------------- status ---------------- */

  function renderStatus() {
    const st = S.status;
    if (!st) return;

    const online = st.online === true;

    setText('#stOnline', online ? 'Online' : 'Offline');
    $('#stOnline').closest('.stat')?.classList.toggle('good', online);
    $('#stOnline').closest('.stat')?.classList.toggle('bad', !online);

    setText('#stFw', `firmware ${st.fw || '—'}`);
    setText('#stIp', st.ip || '—');
    setText('#stRssi', rssiText(st.rssi));
    setText('#stHeap', typeof st.heap === 'number' ? `${Math.round(st.heap / 1024)} KB` : '—');
    setText('#stUptime', fmtUptime(st.uptime));
    setText('#stCommands', typeof st.commands === 'number' ? String(st.commands) : '—');
    setText('#stSchedules', typeof st.schedules === 'number' ? String(st.schedules) : '—');

    setText('#stTime', st.time || 'não sincronizado');
    setText('#stTimeState', st.timeValid ? 'NTP sincronizado' : 'sem NTP');
    $('#stTime').closest('.stat')?.classList.toggle('bad', st.timeValid === false);

    setText('#stLastSend', st.lastSend || '—');

    if (st.ac) {
      S.ac = { ...S.ac, ...st.ac };
      renderAc();
    }

    if (st.learning) {
      setText('#stLearning', `aprendendo: ${st.learnName || '—'} (${st.learnLeft ?? '?'} s)`);
      if (!S.learn) startLearnUI(st.learnName, Number(st.learnLeft) || 0, true);
    } else {
      setText('#stLearning', 'aprendizado: não');
      if (S.learn) stopLearnUI();
    }

    setText('#lastSeen', `status recebido às ${new Date().toLocaleTimeString('pt-BR')}`);
  }

  /* ---------------- ar-condicionado ---------------- */

  function acRepeats() {
    return Math.min(5, Math.max(1, Number($('#acRepeats')?.value) || 1));
  }

  function renderAc() {
    // Controle universal: botoes apontam para comandos raw aprendidos.
    const quick = $('#acQuickActions');
    if (quick) {
      quick.innerHTML = AC_ROLES.map((role) => {
        const command = S.acMap[role.key] || '';
        const classes = ['btn', 'ac-action'];
        if (role.primary) classes.push('primary');
        if (!command) classes.push('unmapped');
        return `
          <button class="${classes.join(' ')}" data-ac-role="${role.key}"
                  ${command ? '' : 'disabled'}
                  title="${command ? `Enviar ${esc(command)}` : 'Não configurado'}">
            <span>${role.label}</span>
            <small>${command ? esc(command) : 'não configurado'}</small>
          </button>`;
      }).join('');
    }

    const unmapped = $('#acUnmapped');
    if (unmapped) {
      unmapped.hidden = AC_ROLES.some((role) => !!S.acMap[role.key]);
    }

    // Secao TCL112AC estruturada (opcional).
    const ac = S.ac;
    const temp = Math.round((Number(ac.temp) || 24) * 2) / 2;
    const tempText = Number.isInteger(temp) ? String(temp) : temp.toFixed(1);

    setText('#acTemp', tempText);
    setText('#acTempInline', tempText);
    setText('#acModeLabel', AC_MODE_LABELS[ac.mode] || ac.mode);
    setText('#acFanLabel', AC_FAN_LABELS[ac.fan] || ac.fan);
    setText('#acSwingLabel', AC_SWING_LABELS[ac.swing] || ac.swing);

    const powerBtn = $('#acPower');
    if (powerBtn) {
      powerBtn.textContent = ac.power ? 'Desligar' : 'Ligar';
      powerBtn.classList.toggle('on', !!ac.power);
    }

    $$('#acModes button').forEach((b) =>
      b.classList.toggle('active', b.dataset.value === ac.mode));
    $$('#acFans button').forEach((b) =>
      b.classList.toggle('active', b.dataset.value === ac.fan));
    $$('#acSwing button').forEach((b) =>
      b.classList.toggle('active', b.dataset.value === ac.swing));
    $$('[data-ac="toggle"]').forEach((b) =>
      b.classList.toggle('active', !!ac[b.dataset.field]));
  }

  function renderAcCommands() {
    const list = $('#acCommandList');
    if (!list) return;

    const term = ($('#acCommandSearch')?.value || '').trim().toLowerCase();
    const visible = term
      ? S.commands.filter((c) => c.name.toLowerCase().includes(term))
      : S.commands;

    const empty = $('#acCommandsEmpty');
    empty.hidden = visible.length > 0;
    empty.innerHTML = S.commands.length
      ? 'Nenhum comando corresponde ao filtro.'
      : 'Nenhum comando carregado. Conecte-se e clique em <strong>Atualizar</strong>.';

    list.innerHTML = visible.map((c) => `
      <div class="item" data-name="${esc(c.name)}">
        <div class="item-main">
          <div class="item-title">${esc(c.name)}</div>
          <div class="item-sub">${c.pulses} pulsos · ${c.freq} kHz · ${esc(c.proto || 'RAW')}${c.bits ? ` · ${c.bits} bits` : ''}</div>
        </div>
        <div class="item-actions">
          <button class="btn small primary" data-ac-send="${esc(c.name)}">Enviar</button>
        </div>
      </div>
    `).join('');
  }

  function renderAcMapGrid() {
    const grid = $('#acMapGrid');
    if (!grid) return;

    grid.innerHTML = AC_ROLES.map((role) => {
      const current = S.acMap[role.key] || '';
      const options = ['<option value="">— nenhum —</option>'];

      for (const c of S.commands) {
        options.push(
          `<option value="${esc(c.name)}" ${c.name === current ? 'selected' : ''}>${esc(c.name)}</option>`
        );
      }

      if (current && !S.commands.some((c) => c.name === current)) {
        options.push(
          `<option value="${esc(current)}" selected>${esc(current)} (não encontrado)</option>`
        );
      }

      return `
        <div class="ac-map-row">
          <span class="ac-map-label">${role.label}</span>
          <select data-role="${role.key}">${options.join('')}</select>
          <button class="btn small" data-learn-role="${role.key}">Aprender</button>
        </div>`;
    }).join('');
  }

  async function sendAcRaw(name) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');
    if (!name) return toast('Nenhum comando atribuído a esta função.', 'warn');

    try {
      await request('send', { name, repeats: acRepeats() }, 20000);
      toast(`"${name}" enviado.`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function handleAcQuick(event) {
    const btn = event.target.closest('button[data-ac-role]');
    if (!btn) return;
    const command = S.acMap[btn.dataset.acRole];
    if (!command) return toast('Função sem comando. Abra a configuração.', 'warn');
    sendAcRaw(command);
  }

  async function saveAcMap(map, message) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');

    try {
      const reply = await request('setAcMap', { map }, 15000);
      if (reply.acMap) S.acMap = { ...S.acMap, ...reply.acMap };
      renderAc();
      renderAcMapGrid();
      if (message) toast(message, 'ok');
      setText('#acMapStatus', '');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function saveAcMapFromForm() {
    const map = {};
    $$('#acMapGrid select[data-role]').forEach((select) => {
      map[select.dataset.role] = select.value;
    });
    saveAcMap(map, 'Configuração do ar salva.');
  }

  async function learnAcRole(role) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');

    const name = normalizeName(`ar_${role}`).slice(0, 24);
    try {
      const reply = await request('learn', { name, timeout: 30 });
      S.learnRole = role;
      setText('#acMapStatus',
        `Aguardando sinal para ${AC_ROLE_LABELS[role] || role}…`);
      $('#learnName').value = reply.name || name;
      startLearnUI(reply.name || name, reply.timeout || 30, false);
      toast(`Aprendendo "${reply.name || name}". Aponte o controle para o receptor.`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function refreshAcData() {
    if (!S.connected) return;

    try {
      await refreshCommands();
      const reply = await request('getAcMap');
      if (reply.acMap) S.acMap = { ...S.acMap, ...reply.acMap };
      renderAc();
      renderAcMapGrid();
    } catch (e) {
      log(`Ar-condicionado: ${e.message}`);
    }
  }

  async function sendAc(patch, message) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');
    if (S.acBusy) return;

    const previous = { ...S.ac };

    // Ao mexer em qualquer ajuste com o ar desligado, liga junto.
    if (!('power' in patch) && !S.ac.power) patch = { ...patch, power: true };

    S.ac = { ...S.ac, ...patch };
    renderAc();

    S.acBusy = true;
    try {
      const reply = await request('ac', S.ac, 20000);
      if (reply.ac) S.ac = { ...S.ac, ...reply.ac };
      renderAc();
      if (message) toast(message, 'ok');
    } catch (e) {
      S.ac = previous;
      renderAc();
      toast(e.message, 'error');
    } finally {
      S.acBusy = false;
    }
  }

  function handleAcClick(event) {
    const btn = event.target.closest('button[data-ac]');
    if (!btn) return;

    const kind = btn.dataset.ac;

    if (kind === 'power') {
      sendAc({ power: !S.ac.power },
             S.ac.power ? 'Ar-condicionado desligado.' : 'Ar-condicionado ligado.');
    } else if (kind === 'temp-down' || kind === 'temp-up') {
      const delta = kind === 'temp-up' ? 0.5 : -0.5;
      const value = Math.min(31, Math.max(16, (Number(S.ac.temp) || 24) + delta));
      if (value !== S.ac.temp) sendAc({ temp: value }, `Temperatura: ${value} °C`);
    } else if (kind === 'mode') {
      sendAc({ mode: btn.dataset.value },
             `Modo: ${AC_MODE_LABELS[btn.dataset.value] || btn.dataset.value}`);
    } else if (kind === 'fan') {
      sendAc({ fan: btn.dataset.value },
             `Ventoinha: ${btn.textContent.trim()}`);
    } else if (kind === 'swing') {
      sendAc({ swing: btn.dataset.value },
             AC_SWING_LABELS[btn.dataset.value] || 'Swing alterado');
    } else if (kind === 'toggle') {
      const field = btn.dataset.field;
      const next = !S.ac[field];
      sendAc({ [field]: next },
             `${btn.textContent.trim()}: ${next ? 'ligado' : 'desligado'}`);
    }
  }

  /* ---------------- comandos ---------------- */

  async function refreshCommands() {
    if (!S.connected) return;

    try {
      const reply = await request('list');
      S.commands = Array.isArray(reply.commands) ? reply.commands : [];
      renderCommands();
      renderCommandOptions();
      renderAcCommands();
      renderAcMapGrid();
      log(`${S.commands.length} comando(s) carregado(s).`);
    } catch (e) {
      log(`Lista de comandos: ${e.message}`);
    }
  }

  function renderCommands() {
    const term = $('#cmdSearch').value.trim().toLowerCase();
    const visible = term
      ? S.commands.filter((c) => c.name.toLowerCase().includes(term))
      : S.commands;

    const empty = $('#commandsEmpty');
    empty.hidden = visible.length > 0;
    empty.innerHTML = S.commands.length
      ? 'Nenhum comando corresponde ao filtro.'
      : 'Nenhum comando carregado. Conecte-se e clique em <strong>Atualizar</strong>, ou aprenda um novo comando na aba <strong>Aprender</strong>.';

    $('#commandList').innerHTML = visible.map((c) => `
      <div class="item" data-name="${esc(c.name)}">
        <div class="item-main">
          <div class="item-title">${esc(c.name)}</div>
          <div class="item-sub">${c.pulses} pulsos · ${c.freq} kHz · ${esc(c.proto || 'RAW')}${c.bits ? ` · ${c.bits} bits` : ''}</div>
        </div>
        <div class="item-actions">
          <button class="btn small primary" data-act="send" data-name="${esc(c.name)}">Enviar</button>
          <button class="btn small" data-act="info" data-name="${esc(c.name)}">Detalhes</button>
          <button class="btn small" data-act="rename" data-name="${esc(c.name)}">Renomear</button>
          <button class="btn small" data-act="freq" data-name="${esc(c.name)}">Frequência</button>
          <button class="btn small danger" data-act="delete" data-name="${esc(c.name)}">Apagar</button>
        </div>
      </div>
    `).join('');
  }

  async function handleCommandAction(act, name) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');

    try {
      if (act === 'send') {
        const repeats = Math.min(10, Math.max(1, Number($('#cmdRepeats').value) || 1));
        await request('send', { name, repeats }, 20000);
        toast(`Comando "${name}" transmitido.`, 'ok');
        return;
      }

      if (act === 'info') {
        const info = await request('info', { name });
        log(`Info ${info.name}: ${info.pulses} pulsos, ${info.freq} kHz, ${info.proto}, ${info.bits} bits, ${info.durationMs} ms, ${info.bytes} bytes.`);
        toast(`${info.name}: ${info.pulses} pulsos, ${info.freq} kHz, ${info.proto}, ${info.durationMs} ms.`, 'info', 7000);
        return;
      }

      if (act === 'rename') {
        const input = prompt(`Novo nome para "${name}":`, name);
        if (input === null) return;
        const newName = normalizeName(input);
        if (!validName(newName)) return toast('Nome inválido.', 'error');
        if (newName === name) return;
        await request('renameCommand', { name, newName });
        toast(`"${name}" renomeado para "${newName}".`, 'ok');
        await refreshCommands();
        return;
      }

      if (act === 'freq') {
        const input = prompt(`Portadora de "${name}" em kHz (20 a 60):`, '38');
        if (input === null) return;
        const khz = Number(input);
        if (!Number.isInteger(khz) || khz < 20 || khz > 60) {
          return toast('Informe um valor entre 20 e 60 kHz.', 'error');
        }
        await request('setFrequency', { name, khz });
        toast(`"${name}" agora usa ${khz} kHz.`, 'ok');
        await refreshCommands();
        return;
      }

      if (act === 'delete') {
        if (!confirm(`Apagar definitivamente o comando "${name}"?`)) return;
        await request('deleteCommand', { name });
        toast(`Comando "${name}" apagado.`, 'ok');
        await refreshCommands();
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---------------- aprender ---------------- */

  async function startLearn() {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');

    S.learnRole = null;

    const name = normalizeName($('#learnName').value);
    if (!validName(name)) {
      toast('Nome inválido. Use letras sem acento, números, _ ou -.', 'error');
      return;
    }

    const timeout = Math.min(120, Math.max(5, Number($('#learnTimeout').value) || 30));

    try {
      const reply = await request('learn', { name, timeout });
      $('#learnName').value = reply.name || name;
      startLearnUI(reply.name || name, reply.timeout || timeout, false);
      toast(`Aprendendo "${reply.name || name}". Pressione a tecla.`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function startLearnUI(name, seconds, fromStatus) {
    const safeSeconds = Math.max(1, Number(seconds) || 1);

    S.learn = {
      name,
      total: safeSeconds,
      end: Date.now() + safeSeconds * 1000,
    };

    $('#learnBox').hidden = false;
    setText('#learnTitle', `Aprendendo "${name}"${fromStatus ? ' (em andamento)' : ''}…`);
    setText('#learnHint', 'Pressione a tecla no controle original.');
    $('#btnLearn').disabled = true;
    $('#btnCancelLearn').disabled = false;
    $('#learnBar').style.width = '100%';

    if (S.learnTimer) clearInterval(S.learnTimer);
    S.learnTimer = setInterval(tickLearn, 250);
    tickLearn();
  }

  function tickLearn() {
    if (!S.learn) return;

    const left = Math.max(0, Math.ceil((S.learn.end - Date.now()) / 1000));
    setText('#learnCount', `${left} s`);

    const pct = S.learn.total ? (left / S.learn.total) * 100 : 0;
    $('#learnBar').style.width = `${pct}%`;

    if (left <= 0) {
      clearInterval(S.learnTimer);
      S.learnTimer = null;
      $('#btnCancelLearn').disabled = true;
    }
  }

  function stopLearnUI() {
    if (S.learnTimer) clearInterval(S.learnTimer);
    S.learnTimer = null;
    S.learn = null;

    $('#learnBox').hidden = true;
    $('#btnLearn').disabled = false;
    $('#btnCancelLearn').disabled = true;
    $('#learnBar').style.width = '0%';
  }

  function addLastLearned(event) {
    S.lastLearned.unshift(event);
    S.lastLearned = S.lastLearned.slice(0, 5);
    renderLastLearned();
  }

  function renderLastLearned() {
    const empty = $('#lastLearnedEmpty');
    if (!S.lastLearned.length) {
      empty.hidden = false;
      $('#lastLearnedList').innerHTML = '';
      return;
    }

    empty.hidden = true;
    $('#lastLearnedList').innerHTML = S.lastLearned.map((c) => `
      <div class="item">
        <div class="item-main">
          <div class="item-title">${esc(c.name)}</div>
          <div class="item-sub">${c.pulses} pulsos · ${c.freq} kHz · ${esc(c.proto || 'RAW')}${c.bits ? ` · ${c.bits} bits` : ''}</div>
        </div>
        <div class="item-actions">
          <button class="btn small primary" data-last-send="${esc(c.name)}">Enviar</button>
        </div>
      </div>
    `).join('');
  }

  /* ---------------- agenda ---------------- */

  async function refreshSchedules() {
    if (!S.connected) return;

    try {
      const reply = await request('listSchedules');
      S.schedules = Array.isArray(reply.schedules) ? reply.schedules : [];
      renderSchedules();
      renderCommandOptions();
    } catch (e) {
      log(`Agenda: ${e.message}`);
    }
  }

  function renderSchedules() {
    const list = $('#scheduleList');

    if (!S.schedules.length) {
      list.innerHTML = `
        <div class="empty">
          Nenhum agendamento. Escolha um comando, um horário e os dias acima.
        </div>`;
      return;
    }

    list.innerHTML = S.schedules.map((s) => `
      <div class="item" data-id="${s.id}">
        <div class="item-main">
          <div class="item-title">${fmtTime(s.hour, s.minute)} · ${esc(s.name)}</div>
          <div class="item-sub">${esc(daysLabel(s.days))} · ${s.repeats}x · ${s.enabled ? 'ativo' : 'desativado'}</div>
        </div>
        <div class="item-actions">
          <button class="btn small" data-act="toggle" data-id="${s.id}" data-enabled="${s.enabled ? '1' : '0'}">
            ${s.enabled ? 'Desativar' : 'Ativar'}
          </button>
          <button class="btn small danger" data-act="delete" data-id="${s.id}">Excluir</button>
        </div>
      </div>
    `).join('');
  }

  function renderCommandOptions() {
    const select = $('#schedCommand');
    const previous = select.value;

    if (!S.commands.length) {
      select.innerHTML = '<option value="">(nenhum comando salvo)</option>';
      return;
    }

    select.innerHTML = S.commands
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`)
      .join('');

    if (S.commands.some((c) => c.name === previous)) select.value = previous;
  }

  async function addSchedule(event) {
    event.preventDefault();
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');

    const name = $('#schedCommand').value;
    if (!name) return toast('Aprenda um comando antes de agendar.', 'warn');

    const time = $('#schedTime').value;
    if (!/^\d{2}:\d{2}$/.test(time)) return toast('Informe um horário válido.', 'error');

    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(3, 5));
    const repeats = Math.min(10, Math.max(1, Number($('#schedRepeats').value) || 1));
    const enabled = $('#schedEnabled').checked;

    let days = 0;
    $$('.days input[type="checkbox"]').forEach((cb) => {
      if (cb.checked) days |= (1 << Number(cb.dataset.day));
    });

    if (!days) return toast('Escolha ao menos um dia da semana.', 'warn');

    try {
      await request('addSchedule', {
        schedule: { name, hour, minute, days, enabled, repeats },
      });
      toast('Agendamento salvo.', 'ok');
      await refreshSchedules();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function handleScheduleAction(act, id, enabled) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');

    try {
      if (act === 'toggle') {
        await request('toggleSchedule', { scheduleId: id, enabled: !enabled });
        await refreshSchedules();
        return;
      }

      if (act === 'delete') {
        if (!confirm('Excluir este agendamento?')) return;
        await request('deleteSchedule', { scheduleId: id });
        await refreshSchedules();
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ---------------- backup ---------------- */

  function setBackupBusy(busy, text, pct) {
    $('#btnExport').disabled = busy;
    $('#btnImport').disabled = busy;
    setText('#backupText', text || 'Nenhuma operação em andamento.');
    if (typeof pct === 'number') $('#backupBar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  async function exportBackup() {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');
    if (S.backup) return toast('Já existe um backup em andamento.', 'warn');

    const collector = {
      items: [],
      expected: 0,
      backupDone: false,
      schedulesReady: false,
      acMapReady: false,
      acMap: {},
      timer: null,
    };

    collector.maybeFinish = () => {
      if (collector.backupDone && collector.schedulesReady && collector.acMapReady) {
        finishBackup(collector);
      }
    };

    S.backup = collector;
    setBackupBusy(true, 'Iniciando backup...', 0);

    collector.timer = setTimeout(() => {
      if (S.backup !== collector) return;
      S.backup = null;
      setBackupBusy(false, 'Tempo esgotado ao gerar o backup.');
      toast('Tempo esgotado ao gerar o backup.', 'error');
    }, 120000);

    try {
      const started = await request('backup', {}, 15000);
      collector.expected = Number(started.count) || 0;
      setBackupBusy(true, `Recebendo comandos (0/${collector.expected})...`, 2);
    } catch (e) {
      clearTimeout(collector.timer);
      S.backup = null;
      setBackupBusy(false, '');
      return toast(e.message, 'error');
    }

    try {
      const reply = await request('listSchedules', {}, 15000);
      S.schedules = Array.isArray(reply.schedules) ? reply.schedules : [];
      renderSchedules();
    } catch (e) {
      log(`Falha ao listar agendamentos no backup: ${e.message}`);
    }

    try {
      const reply = await request('getAcMap', {}, 15000);
      collector.acMap = reply.acMap && typeof reply.acMap === 'object' ? reply.acMap : {};
    } catch (e) {
      log(`Falha ao obter o mapa do ar no backup: ${e.message}`);
    }

    collector.acMapReady = true;
    collector.schedulesReady = true;
    collector.maybeFinish();
  }

  function finishBackup(collector) {
    clearTimeout(collector.timer);
    if (S.backup === collector) S.backup = null;

    const payload = {
      format: 'esp32-ir-backup',
      version: 2,
      env: S.settings.env,
      exportedAt: new Date().toISOString(),
      commands: collector.items,
      schedules: S.schedules.map((s) => ({
        name: s.name,
        hour: s.hour,
        minute: s.minute,
        days: s.days,
        enabled: s.enabled,
        repeats: s.repeats,
      })),
      acMap: collector.acMap,
    };

    downloadJson(payload, `ir-backup-${S.settings.env}-${fileStamp()}.json`);

    setBackupBusy(
      false,
      `${payload.commands.length} comando(s), ${payload.schedules.length} agendamento(s) ` +
      `e ${Object.keys(payload.acMap).length} função(ões) do ar exportados.`,
      100
    );
    toast('Backup gerado com sucesso.', 'ok');
    log(`Backup exportado: ${payload.commands.length} comando(s).`);
  }

  async function importBackup(file) {
    if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');
    if (S.restoring) return toast('Já existe uma restauração em andamento.', 'warn');

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      return toast('Arquivo JSON inválido.', 'error');
    }

    if (data.format !== 'esp32-ir-backup') {
      if (!confirm('Este arquivo não parece ser um backup deste projeto. Continuar?')) return;
    }

    const commands = (Array.isArray(data.commands) ? data.commands : [])
      .filter((c) => c && typeof c.name === 'string' && typeof c.raw === 'string');
    const schedules = Array.isArray(data.schedules) ? data.schedules : [];
    const acMap = data.acMap && typeof data.acMap === 'object' ? data.acMap : {};

    if (!commands.length && !schedules.length && !Object.keys(acMap).length) {
      return toast('O backup está vazio.', 'warn');
    }

    const ok = confirm(
      `Restaurar ${commands.length} comando(s), ${schedules.length} agendamento(s) ` +
      `e ${Object.keys(acMap).length} função(ões) do ar no ambiente "${S.settings.env}"?` +
      `\n\nComandos com o mesmo nome serão sobrescritos.`
    );
    if (!ok) return;

    S.restoring = true;
    const total = commands.length + schedules.length + (Object.keys(acMap).length ? 1 : 0);
    let done = 0;
    let failed = 0;

    setBackupBusy(true, 'Restaurando...', 0);

    for (const command of commands) {
      const name = normalizeName(command.name);
      if (!validName(name)) {
        failed++;
        log(`Nome inválido no backup: ${command.name}`);
      } else {
        try {
          await request(
            'restoreCommand',
            { name, freq: command.freq || 38, raw: command.raw },
            20000
          );
          done++;
        } catch (e) {
          failed++;
          log(`Falha ao restaurar ${name}: ${e.message}`);
        }
      }

      const processed = done + failed;
      setBackupBusy(
        true,
        `Restaurando… ${processed}/${total} (${failed} falha(s))`,
        total ? (processed / total) * 100 : 0
      );
      await sleep(120);
    }

    for (const schedule of schedules) {
      const name = normalizeName(schedule.name);
      if (!validName(name)) {
        failed++;
        log(`Agenda com nome inválido: ${schedule.name}`);
        continue;
      }

      try {
        await request('addSchedule', {
          schedule: {
            name,
            hour: Number(schedule.hour),
            minute: Number(schedule.minute),
            days: Number(schedule.days) || 0x7f,
            enabled: schedule.enabled !== false,
            repeats: Number(schedule.repeats) || 1,
          },
        }, 15000);
        done++;
      } catch (e) {
        failed++;
        log(`Falha ao restaurar agenda ${name}: ${e.message}`);
      }

      const processed = done + failed;
      setBackupBusy(
        true,
        `Restaurando… ${processed}/${total} (${failed} falha(s))`,
        total ? (processed / total) * 100 : 0
      );
      await sleep(100);
    }

    if (Object.keys(acMap).length) {
      try {
        await refreshCommands();
        const known = new Set(S.commands.map((c) => c.name));
        const filtered = {};
        for (const [role, value] of Object.entries(acMap)) {
          if (typeof value === 'string' && known.has(value)) filtered[role] = value;
        }
        const reply = await request('setAcMap', { map: filtered }, 15000);
        if (reply.acMap) S.acMap = { ...S.acMap, ...reply.acMap };
        done++;
      } catch (e) {
        failed++;
        log(`Falha ao restaurar funções do ar: ${e.message}`);
      }

      const processed = done + failed;
      setBackupBusy(
        true,
        `Restaurando… ${processed}/${total} (${failed} falha(s))`,
        total ? (processed / total) * 100 : 0
      );
      await sleep(100);
    }

    S.restoring = false;
    setBackupBusy(
      false,
      `Restauração concluída: ${done} ok, ${failed} falha(s).`,
      100
    );
    toast(`Restauração concluída (${done} ok, ${failed} falha(s)).`,
          failed ? 'warn' : 'ok', 7000);

    await refreshAll();
  }

  /* ---------------- refresh geral ---------------- */

  async function refreshAll() {
    if (!S.connected) return;
    await Promise.allSettled([refreshCommands(), refreshSchedules()]);
    try {
      const reply = await request('getAcMap', {}, 15000);
      if (reply.acMap) S.acMap = { ...S.acMap, ...reply.acMap };
      renderAc();
      renderAcMapGrid();
    } catch (e) {
      log(`Falha ao atualizar funções do ar: ${e.message}`);
    }
  }

  /* ---------------- inicialização ---------------- */

  function bindEvents() {
    $('#btnConnect').addEventListener('click', connect);
    $('#btnDisconnect').addEventListener('click', disconnect);

    for (const input of ['#inRoot', '#inEnv']) {
      $(input).addEventListener('input', updatePreview);
    }

    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
        $$('.tab-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === `tab-${btn.dataset.tab}`);
        });

        if (btn.dataset.tab === 'commands' || btn.dataset.tab === 'schedules') {
          if (S.connected) refreshAll();
        }

        if (btn.dataset.tab === 'ac') {
          renderAc();
          if (S.connected) {
            refreshAcData();
            request('publishStatus').catch(() => {});
          }
        }
      });
    });

    $('#tab-ac').addEventListener('click', handleAcClick);
    $('#acQuickActions').addEventListener('click', handleAcQuick);

    $('#acCommandSearch').addEventListener('input', renderAcCommands);
    $('#btnRefreshAcCommands').addEventListener('click', refreshAcData);

    $('#acCommandList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-ac-send]');
      if (btn) sendAcRaw(btn.dataset.acSend);
    });

    $('#btnSaveAcMap').addEventListener('click', saveAcMapFromForm);
    $('#btnReloadAcMap').addEventListener('click', refreshAcData);

    $('#acMapGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-learn-role]');
      if (btn) learnAcRole(btn.dataset.learnRole);
    });

    $('#btnRefreshStatus').addEventListener('click', async () => {
      if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');
      try { await request('publishStatus'); } catch (e) { toast(e.message, 'error'); }
    });

    $('#btnReboot').addEventListener('click', async () => {
      if (!S.connected) return toast('Conecte-se ao broker primeiro.', 'warn');
      if (!confirm('Reiniciar o ESP32 agora?')) return;
      try { await request('reboot', {}, 5000); } catch (e) { /* pode reiniciar antes de responder */ }
      toast('ESP32 reiniciando…', 'warn');
      setConnected(false);
      setConnState('connecting', 'Reiniciando…');
    });

    $('#btnRefreshCommands').addEventListener('click', refreshCommands);
    $('#cmdSearch').addEventListener('input', renderCommands);

    $('#commandList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      handleCommandAction(btn.dataset.act, btn.dataset.name);
    });

    $('#lastLearnedList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-last-send]');
      if (!btn) return;
      handleCommandAction('send', btn.dataset.lastSend);
    });

    $('#btnLearn').addEventListener('click', startLearn);
    $('#learnName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startLearn();
    });

    $('#btnCancelLearn').addEventListener('click', async () => {
      if (!S.connected) return;
      try { await request('cancelLearn'); } catch (e) { /* ignora */ }
      stopLearnUI();
    });

    $('#scheduleForm').addEventListener('submit', addSchedule);

    $('#scheduleList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      handleScheduleAction(
        btn.dataset.act,
        Number(btn.dataset.id),
        btn.dataset.enabled === '1'
      );
    });

    $('#btnExport').addEventListener('click', exportBackup);
    $('#btnImport').addEventListener('click', () => $('#fileInput').click());

    $('#fileInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) await importBackup(file);
    });

    $('#btnClearLog').addEventListener('click', () => {
      S.logLines = [];
      $('#logBox').textContent = '';
    });

    $('#btnDisconnect').disabled = true;
  }

  function init() {
    fillForm();
    bindEvents();

    renderCommands();
    renderSchedules();
    renderCommandOptions();
    renderLastLearned();
    renderAc();
    renderAcCommands();
    renderAcMapGrid();
    setConnected(false);

    log('Painel iniciado. Biblioteca MQTT: ' +
        (typeof mqtt === 'undefined' ? 'não carregada' : 'ok'));

    if (S.settings.password) {
      setTimeout(connect, 700);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
