(() => {
  const $ = (id) => document.getElementById(id);
  const STORE = 'controleIrCentral.v1';
  let client = null;
  let devices = loadDevices();
  const states = {};
  const logs = [];

  function loadDevices(){try{const d=JSON.parse(localStorage.getItem(STORE)||'[]');return Array.isArray(d)?d:[]}catch{return []}}
  function saveDevices(){localStorage.setItem(STORE,JSON.stringify(devices));render()}
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function topic(id,leaf){return `ir/v1/${id}/${leaf}`}
  function connected(){return !!client&&client.connected}
  function log(message){const time=new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});logs.unshift({time,message});if(logs.length>100)logs.pop();$('logs').innerHTML=logs.map(x=>`<div class="log-row"><span class="log-time">${x.time}</span><span class="log-message">${esc(x.message)}</span></div>`).join('')||'<div class="log-empty">Nenhuma atividade ainda.</div>'}
  function setConnection(on,text){$('connection').className='status '+(on?'online':'offline');$('connection').querySelector('span').textContent=text;$('toggleConnection').textContent=on?'Desconectar':'Conectar'}
  function publish(id,leaf,payload=''){if(!connected()){log('Não conectado ao EMQX.');return false}client.publish(topic(id,'cmd/'+leaf),String(payload),{qos:0,retain:false},err=>{if(err)log(`Falha ao enviar ${leaf} para ${id}: ${err.message}`)});log(`Enviado para ${id}: ${leaf}${payload!==''?' → '+payload:''}`);return true}
  function connect(){if(typeof mqtt==='undefined'){ $('connectError').hidden=false;$('connectError').textContent='A biblioteca MQTT.js não carregou. Verifique a internet ou a CDN.';return }
    const url=$('broker').value.trim(),username=$('mqttUser').value,password=$('mqttPass').value;
    if(!url||!username){$('connectError').hidden=false;$('connectError').textContent='Informe o endereço WSS e o usuário MQTT.';return}
    $('connectError').hidden=true;$('toggleConnection').disabled=true;
    try{client=mqtt.connect(url,{username,password,clientId:'ir-panel-'+Math.random().toString(16).slice(2,10),clean:true,connectTimeout:10000,reconnectPeriod:3000,keepalive:30});
      client.on('connect',()=>{setConnection(true,'Conectado ao EMQX');$('connectError').hidden=true;client.subscribe('ir/v1/+/evt/#',{qos:0},err=>{if(err)log('Erro ao assinar eventos: '+err.message);else log('Inscrito nos eventos dos ESP32.');});devices.forEach(d=>{publish(d.id,'getstatus','');publish(d.id,'list','')})});
      client.on('reconnect',()=>setConnection(false,'Reconectando…'));
      client.on('close',()=>{setConnection(false,'Desconectado');$('toggleConnection').disabled=false});
      client.on('error',err=>{ $('connectError').hidden=false;$('connectError').textContent='Erro MQTT: '+err.message;log('Erro MQTT: '+err.message);});
      client.on('message',(t,p)=>handleMessage(t,p.toString()));
    }catch(e){$('connectError').hidden=false;$('connectError').textContent=e.message;$('toggleConnection').disabled=false}
  }
  function disconnect(){if(client){client.end(true);client=null}setConnection(false,'Desconectado');$('toggleConnection').disabled=false}
  function handleMessage(t,payload){const m=t.match(/^ir\/v1\/([^/]+)\/evt\/(.+)$/);if(!m)return;const id=m[1],leaf=m[2];states[id]=states[id]||{online:false,commands:[],lastSeen:null};states[id].lastSeen=new Date().toISOString();
    if(leaf==='status'){try{const s=JSON.parse(payload);states[id].online=!!s.mqtt;states[id].ip=s.ip||'';states[id].room=s.room||'';states[id].wifi=!!s.wifi}catch{}}
    else if(leaf==='commands'){try{const x=JSON.parse(payload);states[id].commands=Array.isArray(x.commands)?x.commands:[]}catch{log(`Lista de comandos inválida recebida de ${id}`)}}
    else if(leaf==='result'){states[id].lastResult=payload;log(`${id}: ${payload}`);if(/^(SALVO:|APAGADO:|ENVIADO:)/.test(payload))setTimeout(()=>publish(id,'list',''),250)}
    render();
  }
  function render(){
    $('deviceCount').textContent=`${devices.length} placa${devices.length===1?'':'s'}`;
    $('roomList').innerHTML=devices.map(d=>`<div class="room-item"><div><strong>${esc(d.room)}</strong><small>${esc(d.label||d.id)} · ${esc(d.id)}</small></div><button class="danger" data-remove="${esc(d.id)}" title="Remover cadastro">Remover</button></div>`).join('')||'<p class="hint">Nenhum cômodo cadastrado.</p>';
    $('emptyState').classList.toggle('hidden',devices.length>0);
    $('deviceGrid').innerHTML=devices.map(d=>{const s=states[d.id]||{online:false,commands:[]};const commands=s.commands||[];
      return `<article class="device-card"><div class="device-head"><div><h3>${esc(d.room)}</h3><p>${esc(d.label||'ESP32')} · ${esc(d.id)}</p></div><span class="pill ${s.online?'online':''}">${s.online?'Visto':'Aguardando'}</span></div>
      <div class="device-meta"><span class="meta">Wi-Fi: ${s.wifi?'conectado':s.online?'verificando':'—'}</span><span class="meta">IP: ${esc(s.ip||'—')}</span><span class="meta">${commands.length} comandos</span></div>
      <div class="actions"><button class="secondary" data-list="${esc(d.id)}">Listar comandos</button><button class="secondary" data-status="${esc(d.id)}">Verificar placa</button></div>
      <div class="learn-row"><input id="learn-${esc(d.id)}" maxlength="23" pattern="[A-Za-z0-9_-]+" placeholder="Nome: tv_power"><button class="primary" data-learn="${esc(d.id)}">Aprender IR</button></div>
      <p class="hint">Clique em Aprender IR e pressione o botão correspondente no controle original, apontado ao receptor.</p>
      <div class="command-list">${commands.map(c=>`<div class="command"><strong>${esc(c.name)}</strong><button class="primary" data-send="${esc(d.id)}" data-name="${esc(c.name)}">Enviar</button><button class="danger" data-erase="${esc(d.id)}" data-name="${esc(c.name)}">Apagar</button></div>`).join('')||'<p class="hint">Nenhum comando listado. Clique em “Listar comandos” ou aprenda um novo.</p>'}</div></article>`;
    }).join('');
  }
  $('toggleConnection').addEventListener('click',()=>connected()?disconnect():connect());
  $('deviceForm').addEventListener('submit',e=>{e.preventDefault();const room=$('roomName').value.trim(),id=$('deviceId').value.trim(),label=$('deviceLabel').value.trim();if(!/^[A-Za-z0-9_-]{1,48}$/.test(id)){alert('O ID deve conter apenas letras, números, _ ou -');return}if(devices.some(d=>d.id===id)){alert('Esse ID já está cadastrado. Cada ESP32 precisa de um ID único.');return}devices.push({room,id,label});saveDevices();e.target.reset();log(`Cadastrado ${id} no cômodo ${room}.`);if(connected()){publish(id,'getstatus','');publish(id,'list','')}});
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const id=b.dataset.remove;if(id){if(confirm(`Remover o cadastro ${id}? O ESP32 não será apagado nem reconfigurado.`)){devices=devices.filter(d=>d.id!==id);saveDevices();log(`Cadastro removido: ${id}`)}return}
    const did=b.dataset.list||b.dataset.status;if(did){publish(did,b.dataset.list?'list':'getstatus','');return}
    if(b.dataset.learn){const name=$('learn-'+b.dataset.learn).value.trim();if(!/^[A-Za-z0-9_-]{1,23}$/.test(name)){alert('Use 1 a 23 caracteres: letras, números, _ ou -');return}publish(b.dataset.learn,'learn',name);return}
    if(b.dataset.send){if(confirm(`Enviar o comando “${b.dataset.name}” para ${b.dataset.send}?`))publish(b.dataset.send,'send',b.dataset.name);return}
    if(b.dataset.erase){if(confirm(`Apagar “${b.dataset.name}” da memória do ESP32 ${b.dataset.erase}?`))publish(b.dataset.erase,'erase',b.dataset.name)}
  });
  $('refreshAll').addEventListener('click',()=>devices.forEach(d=>{publish(d.id,'getstatus','');publish(d.id,'list','')}));
  $('clearLog').addEventListener('click',()=>{logs.length=0;$('logs').innerHTML='<div class="log-empty">Nenhuma atividade ainda.</div>'});
  $('exportConfig').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(devices,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='controle-ir-cômodos.json';a.click();URL.revokeObjectURL(a.href)});
  $('importConfig').addEventListener('click',()=>$('importFile').click());
  $('importFile').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{const data=JSON.parse(await f.text());if(!Array.isArray(data)||data.some(d=>!d.room||!d.id||!/^[A-Za-z0-9_-]{1,48}$/.test(d.id)))throw Error('Formato inválido');const seen=new Set();for(const d of data){if(seen.has(d.id))throw Error('IDs duplicados no arquivo');seen.add(d.id)}devices=data.map(d=>({room:String(d.room),id:String(d.id),label:String(d.label||'')}));saveDevices();log('Configuração importada.')}catch(err){alert('Não foi possível importar: '+err.message)}e.target.value=''});
  render();
})();
