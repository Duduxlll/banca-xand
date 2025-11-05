/* =========================================
   Depósito PIX – front (produção)
   - Prioriza LivePix (redirect); fallback Efi (QR)
   - Campo da chave SEMPRE visível (inclui CPF)
   - Nunca manda a chave para o LivePix (só nome+valor)
   ========================================= */

const API = window.location.origin;

/* ===== Seletores ===== */
const nomeInput   = document.querySelector('#nome');
const tipoSelect  = document.querySelector('#tipoChave');
const chaveWrap   = document.querySelector('#chaveWrapper');
const chaveInput  = document.querySelector('#chavePix');
const valorInput  = document.querySelector('#valor');
const form        = document.querySelector('#depositoForm');
const toast       = document.querySelector('#toast');
const btnSubmit   = document.querySelector('#btnDepositar');

// Resumo
const rNome    = document.querySelector('#r-nome');
const rTipo    = document.querySelector('#r-tipo');
const rChaveLi = document.querySelector('#r-chave-li') || document.querySelector('#resumo li:nth-child(3)');
const rChave   = document.querySelector('#r-chave');
const rValor   = document.querySelector('#r-valor');

/* ===== Utils ===== */
if (document.querySelector('#ano')) document.querySelector('#ano').textContent = new Date().getFullYear();

function notify(msg, isError=false, time=3200){
  if(!toast){ alert(msg); return; }
  toast.textContent = msg;
  toast.style.borderColor = isError ? 'rgba(255,92,122,.45)' : 'rgba(0,209,143,.45)';
  toast.classList.add('show');
  setTimeout(()=>toast.classList.remove('show'), time);
}
function centsToBRL(c){ return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function toCentsMasked(str){ return Number((str||'').replace(/\D/g,'')||0); }
function getMeta(name){
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.content : '';
}

/* ===== Máscaras & Resumo ===== */
nomeInput?.addEventListener('input', () => { if (rNome) rNome.textContent = nomeInput.value.trim() || '—'; });

function maskCPF(raw){
  let v = String(raw||'').replace(/\D/g,'').slice(0,11);
  v = v.replace(/(\d{3})(\d)/,'$1.$2')
       .replace(/(\d{3})(\d)/,'$1.$2')
       .replace(/(\d{3})(\d{1,2})$/,'$1-$2');
  return v;
}
function maskPhone(raw){
  let v = String(raw||'').replace(/\D/g,'').slice(0,11);
  if(v.length > 2) v = `(${v.slice(0,2)}) ${v.slice(2)}`;
  if(v.length > 10) v = `${v.slice(0,10)}-${v.slice(10)}`;
  return v;
}

function updateTipoUI(){
  if (!tipoSelect) return;
  const t = tipoSelect.value;

  // Campo da chave e item do resumo: SEMPRE visíveis
  if (chaveWrap) chaveWrap.style.display = '';
  if (rChaveLi)  rChaveLi.style.display  = '';

  if (rTipo) rTipo.textContent = t === 'aleatoria' ? 'Chave aleatória' : (t.charAt(0).toUpperCase()+t.slice(1));

  if (!chaveInput) return;

  if (t === 'cpf'){
    chaveInput.placeholder = '000.000.000-00';
    chaveInput.value = maskCPF(chaveInput.value);
  } else if (t === 'telefone'){
    chaveInput.placeholder = '(00) 90000-0000';
    chaveInput.value = maskPhone(chaveInput.value);
  } else if (t === 'email'){
    chaveInput.placeholder = 'seu@email.com';
  } else {
    // aleatória
    chaveInput.placeholder = 'Ex.: 2e1a-…';
  }
  if (rChave) rChave.textContent = (chaveInput.value || '—').trim();
}
tipoSelect?.addEventListener('change', updateTipoUI);
updateTipoUI();

chaveInput?.addEventListener('input', () => {
  if (!tipoSelect || !chaveInput) return;
  const t = tipoSelect.value;
  if (t === 'cpf'){
    chaveInput.value = maskCPF(chaveInput.value);
  } else if (t === 'telefone'){
    chaveInput.value = maskPhone(chaveInput.value);
  }
  if (rChave) rChave.textContent = chaveInput.value.trim() || '—';
});

// Valor com máscara R$
valorInput?.addEventListener('input', () => {
  let v = valorInput.value.replace(/\D/g,'');
  if(!v){ if (rValor) rValor.textContent='—'; valorInput.value=''; return; }
  v = v.replace(/^0+/, '');
  if(v.length < 3) v = v.padStart(3,'0');
  const money = centsToBRL(parseInt(v,10));
  valorInput.value = money;
  if (rValor) rValor.textContent = money;
});

/* ===== Validações ===== */
function isCPFValid(cpf){
  cpf = (cpf||'').replace(/\D/g,'');
  if(cpf.length !== 11 || /^([0-9])\1+$/.test(cpf)) return false;
  let s=0,r;
  for (let i=1;i<=9;i++) s += parseInt(cpf.substring(i-1,i))*(11-i);
  r = (s*10)%11; if(r===10||r===11) r=0; if(r!==parseInt(cpf.substring(9,10))) return false;
  s=0; for (let i=1;i<=10;i++) s += parseInt(cpf.substring(i-1,i))*(12-i);
  r = (s*10)%11; if(r===10||r===11) r=0; return r===parseInt(cpf.substring(10,11));
}
function isEmail(v){ return /.+@.+\..+/.test(v); }

// showError à prova de elementos ausentes
function showError(sel, ok){
  const el = document.querySelector(sel);
  if (!el) return; // evita "classList of null"
  ok ? el.classList.remove('show') : el.classList.add('show');
}

/* ===== Modal de QR (fallback Efi) ===== */
function ensurePixStyles(){
  if (!document.getElementById('pixCss')) {
    const link = document.createElement('link');
    link.id = 'pixCss';
    link.rel = 'stylesheet';
    link.href = 'assets/css/pix.css';
    document.head.appendChild(link);
  }
}
function ensurePixModal(){
  ensurePixStyles();
  let dlg = document.querySelector('#pixModal');
  if (dlg) return dlg;

  dlg = document.createElement('dialog');
  dlg.id = 'pixModal';
  dlg.className = 'pix-modal';

  const card = document.createElement('div'); card.className = 'pix-card';
  const title = document.createElement('h3'); title.className = 'pix-title'; title.textContent = 'Escaneie para pagar';
  const qrWrap = document.createElement('div'); qrWrap.className = 'pix-qr-wrap';
  const img = document.createElement('img'); img.id = 'pixQr'; img.className = 'pix-qr'; img.alt = 'QR Code do PIX';
  const code = document.createElement('div'); code.className = 'pix-code';
  const emv = document.createElement('input'); emv.id = 'pixEmv'; emv.className = 'pix-emv'; emv.readOnly = true;
  const copy = document.createElement('button'); copy.id = 'btnCopy'; copy.className = 'pix-copy btn cta cta--small'; copy.textContent = 'Copiar';
  const status = document.createElement('p'); status.id = 'pixStatus'; status.className = 'pix-status'; status.textContent = 'Aguardando pagamento…';
  const actions = document.createElement('div'); actions.className = 'pix-actions';
  const close = document.createElement('button'); close.id = 'btnFechar'; close.className = 'pix-close btn-outline'; close.textContent = 'Fechar';

  qrWrap.appendChild(img);
  code.appendChild(emv);
  code.appendChild(copy);
  actions.appendChild(close);
  [title, qrWrap, code, status, actions].forEach(n => card.appendChild(n));
  dlg.appendChild(card);
  document.body.appendChild(dlg);

  dlg.addEventListener('cancel', (e)=>{ e.preventDefault(); dlg.close(); });
  dlg.addEventListener('click', (e)=>{ if(e.target === dlg) dlg.close(); });
  copy.onclick = async ()=> {
    const emvEl = dlg.querySelector('#pixEmv');
    if (!emvEl.value) return;
    await navigator.clipboard.writeText(emvEl.value);
    notify('Código copia e cola copiado!');
  };
  close.onclick = ()=> dlg.close();

  return dlg;
}

/* ===== Chamadas ao backend ===== */

// 1) Tenta LivePix primeiro
async function criarPagamentoLivePix({ nome, valorCentavos, tipo, chave }){
  const APP_KEY = window.APP_PUBLIC_KEY || getMeta('app-key') || '';
  const resp = await fetch(`${API}/api/livepix/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(APP_KEY ? { 'X-APP-KEY': APP_KEY } : {})
    },
    // Somente nome e valor vão para o provedor; meta fica pro seu back
    body: JSON.stringify({
      nome,
      valorCentavos,
      meta: { pixType: tipo, pixKey: chave }
    })
  });
  if (resp.status === 404) return { notAvailable: true }; // servidor sem LivePix
  if (!resp.ok) {
    let msg = 'Falha ao criar pagamento (LivePix)';
    try { const j = await resp.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return resp.json(); // { redirectUrl }
}

// 2) Fallback para Efi (QR) se LivePix indisponível
async function criarCobrancaPIX({ nome, cpf, valorCentavos }){
  const resp = await fetch(`${API}/api/pix/cob`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ nome, cpf, valorCentavos })
  });
  if(!resp.ok){
    let err = 'Falha ao criar PIX';
    try{ const j = await resp.json(); if(j.error) err = j.error; }catch{}
    throw new Error(err);
  }
  return resp.json(); // { token, emv, qrPng } OU { txid, emv, qrPng }
}

/* ===== Submit ===== */
form?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const tipo  = tipoSelect.value;
  const chave = (chaveInput?.value || '').trim();

  // Validações por tipo
  let chaveOk = true;
  if (tipo === 'cpf')            chaveOk = isCPFValid(chave);
  else if (tipo === 'email')     chaveOk = isEmail(chave);
  else if (tipo === 'telefone')  chaveOk = chave.replace(/\D/g,'').length === 11;
  else                           chaveOk = chave.length >= 10; // aleatória

  const nomeOk  = nomeInput.value.trim().length > 2;
  const valorCentavos = toCentsMasked(valorInput.value);
  const valorOk       = valorCentavos >= 1000; // R$10,00

  showError('#nomeError', nomeOk);
  showError('#chaveError',chaveOk);
  showError('#valorError',valorOk);
  // Se existir cpfError em algum HTML antigo, não quebrará:
  showError('#cpfError', true);

  if (!(nomeOk && chaveOk && valorOk)){
    notify('Por favor, corrija os campos destacados.', true);
    return;
  }

  try{
    if (btnSubmit) btnSubmit.disabled = true;

    // ===== 1) Tenta LivePix (redirect) =====
    const live = await criarPagamentoLivePix({
      nome: nomeInput.value.trim(),
      valorCentavos,
      tipo,
      chave // NÃO é enviado ao LivePix, só vai no meta do seu back
    });

    if (live?.redirectUrl){
      window.location.href = live.redirectUrl; // vai para a página do LivePix
      return;
    }

    // ===== 2) Fallback: Efi (QR modal + polling) =====
    if (live?.notAvailable){
      const cpfParaEfi = (tipo === 'cpf') ? chave : '';
      const cob = await criarCobrancaPIX({
        nome: nomeInput.value.trim(),
        cpf: cpfParaEfi,
        valorCentavos
      });
      const tokenOrTxid = cob.token || cob.txid;
      const { emv, qrPng } = cob;

      const dlg = ensurePixModal();
      const img = dlg.querySelector('#pixQr');
      const emvEl = dlg.querySelector('#pixEmv');
      const st = dlg.querySelector('#pixStatus');
      img.src = qrPng;
      emvEl.value = emv;
      st.textContent = 'Aguardando pagamento…';
      if(typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open','');

      // Polling do status
      async function check(){
        const s = await fetch(`${API}/api/pix/status/${encodeURIComponent(tokenOrTxid)}`).then(r=>r.json());
        return s.status === 'CONCLUIDA';
      }

      let tries = 36; // 3 min (5s cada)
      const timer = setInterval(async ()=>{
        tries--;
        try{
          const ok = await check();
          if (ok) {
            clearInterval(timer);
            st.textContent = 'Pagamento confirmado! ✅';
            // Confirma no servidor (salva na Área) — universal (token ou txid aceitos)
            const APP_KEY = window.APP_PUBLIC_KEY || getMeta('app-key') || '';
            fetch(`${API}/api/pix/confirmar`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(APP_KEY ? { 'X-APP-KEY': APP_KEY } : {})
              },
              body: JSON.stringify({
                token: tokenOrTxid,
                txid: tokenOrTxid,
                nome: nomeInput.value.trim(),
                valorCentavos,
                tipo,
                chave
              })
            }).catch(()=>{ /* se falhar, a Área deve refletir via webhook/SSE depois */ });

            setTimeout(()=>{ dlg.close(); notify('Pagamento confirmado! Registro salvo.', false, 4500); }, 900);
          } else if (tries <= 0) {
            clearInterval(timer);
            st.textContent = 'Tempo esgotado. Se já pagou, a confirmação aparecerá na Área.';
          }
        }catch(loopErr){
          console.error(loopErr);
        }
      }, 5000);
    }

  }catch(e){
    console.error(e);
    notify('Não foi possível iniciar o pagamento. Tente novamente.', true);
  } finally {
    if (btnSubmit) btnSubmit.disabled = false;
  }
});
