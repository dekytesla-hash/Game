/* Arena UI + gameplay orchestration.
   - Shows Arena menu + matchmaking status
   - Animates dice rolls received from server
   - Applies loot transfer and shows defeat effects */

(function(){
  const $=id=>document.getElementById(id);
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));

  const st={
    open:false,
    wheelResults:[null,null,null],
    wheelRounds:{a:0,b:0},
    opponentId:null,
    isPlayerA:false, // Track if we are player A
    fxRaf:null,
    fxParticles:[],
    fxSplats:[]
  };

  function ensureReadyForArena(){
    // Sehr defensiv: Arena darf fast immer gestartet werden.
    // Einzige harte Sperre: der Held ist bereits tot.
    try{
      if(window.gs && gs.hero && typeof gs.hero.hearts==='number' && gs.hero.hearts<0){
        return {ok:false,reason:'Du bist besiegt. Starte neu, um die Arena zu betreten.'};
      }
    }catch{
      // Falls irgendetwas schiefgeht, Arena trotzdem erlauben.
    }
    return {ok:true};
  }

  function showArena(){
    const ov=$('arenaOv');
    if(!ov) return;
    ov.style.display='flex';
    st.open=true;
  }
  function hideArena(){
    const ov=$('arenaOv');
    if(!ov) return;
    ov.style.display='none';
    st.open=false;
  }

  function setView(which){
    const menu=$('arenaMenu'),match=$('arenaMatch');
    if(!menu||!match) return;
    menu.style.display=(which==='menu')?'block':'none';
    match.style.display=(which==='match')?'block':'none';
  }

  function setStatus(msg){
    const el=$('arenaStatus');
    if(el) el.textContent=msg||'';
  }
  function setWarn(msg){
    const w=$('arenaWarn');
    if(!w) return;
    if(msg){w.style.display='block';w.textContent=msg;}
    else{w.style.display='none';w.textContent='';}
  }
  function setButtons({searchVisible,cancelVisible,searchDisabled}){
    const s=$('arenaSearchBtn'),c=$('arenaCancelBtn');
    if(s){s.style.display=searchVisible?'':'none';s.disabled=!!searchDisabled;}
    if(c){c.style.display=cancelVisible?'':'none';}
  }

  function resetMatchUI(){
    st.wheelResults=[null,null,null];
    st.wheelRounds={a:0,b:0};
    st.opponentId=null;
    const youRow=$('arenaYouDice'),oppRow=$('arenaOppDice');
    if(youRow) youRow.innerHTML='';
    if(oppRow) oppRow.innerHTML='';
    for(let i=0;i<3;i++){
      if(youRow){const d=document.createElement('div');d.className='arena-die';d.textContent='—';d.dataset.idx=String(i);youRow.appendChild(d);}
      if(oppRow){const d=document.createElement('div');d.className='arena-die';d.textContent='—';d.dataset.idx=String(i);oppRow.appendChild(d);}
    }
    const yt=$('arenaYouTotal'),ot=$('arenaOppTotal');
    if(yt) yt.textContent='Siege: 0/3';
    if(ot) ot.textContent='Siege: 0/3';
    const res=$('arenaResult');
    if(res){res.className='arena-result';res.textContent='Runde 1/3';}
    const yg=$('arenaYouGrave'),og=$('arenaOppGrave');
    if(yg) yg.style.display='none';
    if(og) og.style.display='none';
    clearFx();
    paintArenaBackdrop();
  }

  function sum3(a){return a.reduce((s,x)=>s+(x||0),0);}
  function updateTotals(){
    const yt=$('arenaYouTotal'),ot=$('arenaOppTotal');
    if(yt) yt.textContent='Siege: '+st.wheelRounds.a+'/3';
    if(ot) ot.textContent='Siege: '+st.wheelRounds.b+'/3';
  }

  async function animateDie(el,value){
    if(!el) return;
    el.classList.remove('final');
    el.classList.add('rolling');
    const t0=performance.now();
    const dur=1900;
    while(performance.now()-t0<dur){
      el.textContent=String(Math.floor(Math.random()*100))+'%';
      await wait(80);
    }
    el.classList.remove('rolling');
    el.textContent=String(value)+'%';
    el.classList.add('final');
  }

  function snapshotState(){
    // Keep this simple: gold + bag + equipped. (Server decides the winner and does the transfer.)
    const safe=(x)=>JSON.parse(JSON.stringify(x));
    return safe({
      clsId:gs.cls?.id||null,
      hero:{gold:gs.hero.gold,hearts:gs.hero.hearts,maxHearts:gs.hero.maxHearts,level:gs.hero.level},
      bag:gs.bag,
      equipped:gs.equipped
    });
  }

  function addItemToBag(it){
    const idx=gs.bag.findIndex(x=>x===null);
    if(idx===-1) return false;
    gs.bag[idx]=it;
    return true;
  }

  function applyTransferIfWinner(transfer){
    if(!transfer) return;
    const gold=Number(transfer.gold||0);
    if(gold>0) gs.hero.gold+=gold;
    const items=Array.isArray(transfer.items)?transfer.items:[];
    let taken=0,dropped=0;
    for(const it of items){
      if(addItemToBag(it)) taken++;
      else dropped++;
    }
    if(typeof window.addLog==='function'){
      addLog('⚔ Arena-Sieg! +'+gold+' Gold, '+taken+' Item(s) erbeutet'+(dropped?(' (+'+dropped+' fallen gelassen)'):'')+'.','lo');
    }
    if(typeof window.render==='function') render();
  }

  function applyLossIfLoser(){
    // Arena loss = death for now (simple, explicit).
    gs.hero.hearts=0;
    gs.hero.gold=0;
    gs.equipped={};
    gs.bag=Array(20).fill(null);
    if(typeof window.addLog==='function') addLog('💀 Arena-Niederlage. Du wurdest besiegt.','lb');
    if(typeof window.render==='function') render();
  }

  function setResult(kind,text){
    const r=$('arenaResult');
    if(!r) return;
    r.className='arena-result '+(kind||'info');
    r.textContent=text||'';
  }

  function resizeFxCanvas(){
    const cv=$('arenaFx');
    if(!cv) return;
    const rect=cv.getBoundingClientRect();
    const dpr=window.devicePixelRatio||1;
    const w=Math.max(1,Math.floor(rect.width*dpr));
    const h=Math.max(1,Math.floor(rect.height*dpr));
    if(cv.width!==w) cv.width=w;
    if(cv.height!==h) cv.height=h;
  }

  function paintArenaBackdrop(){
    const cv=$('arenaFx'); if(!cv) return;
    resizeFxCanvas();
    const ctx=cv.getContext('2d');
    const w=cv.width,h=cv.height;
    ctx.clearRect(0,0,w,h);
    // Subtle arena floor.
    const g=ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0,'rgba(0,0,0,.00)');
    g.addColorStop(1,'rgba(0,0,0,.35)');
    ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle='rgba(201,168,76,.10)';
    ctx.lineWidth=Math.max(1,Math.floor((window.devicePixelRatio||1)));
    for(let y=0;y<h;y+=28* (window.devicePixelRatio||1)){
      ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    }
  }

  function clearFx(){
    if(st.fxRaf) cancelAnimationFrame(st.fxRaf);
    st.fxRaf=null;
    st.fxParticles=[];
    st.fxSplats=[];
    paintArenaBackdrop();
  }

  function spawnBlood(whichSide){
    clearFx();
    const cv=$('arenaFx'); if(!cv) return;
    const ctx=cv.getContext('2d');
    const w=cv.width,h=cv.height;
    const left=whichSide==='you';
    const cx=left?Math.floor(w*0.30):Math.floor(w*0.70);
    const cy=Math.floor(h*0.55);

    // Static splats.
    for(let i=0;i<18;i++){
      st.fxSplats.push({
        x:cx+(Math.random()-0.5)*120,
        y:cy+(Math.random()-0.5)*90,
        r:8+Math.random()*22,
        a:0.35+Math.random()*0.35
      });
    }
    // Particles.
    for(let i=0;i<140;i++){
      const ang=(Math.random()*Math.PI*2);
      const sp=2.5+Math.random()*6.5;
      st.fxParticles.push({
        x:cx,y:cy,
        vx:Math.cos(ang)*sp*(left?1:-1),
        vy:Math.sin(ang)*sp-2.0,
        r:2+Math.random()*5.5,
        a:0.85,
        life:40+Math.random()*40
      });
    }

    let frame=0;
    const tick=()=>{
      frame++;
      paintArenaBackdrop();

      // Draw splats first (stay).
      for(const s of st.fxSplats){
        ctx.beginPath();
        ctx.fillStyle='rgba(139,0,0,'+s.a+')';
        ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
        ctx.fill();
      }

      // Update + draw particles.
      const grav=0.22*(window.devicePixelRatio||1);
      st.fxParticles=st.fxParticles.filter(p=>p.life>0 && p.a>0.02);
      for(const p of st.fxParticles){
        p.life-=1;
        p.vy+=grav;
        p.x+=p.vx;
        p.y+=p.vy;
        p.a*=0.97;
        ctx.beginPath();
        ctx.fillStyle='rgba(170,20,20,'+clamp(p.a,0,1)+')';
        ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
        ctx.fill();
      }

      if(frame<120 && (st.fxParticles.length>0 || frame<40)){
        st.fxRaf=requestAnimationFrame(tick);
      }else{
        st.fxRaf=null;
      }
    };
    st.fxRaf=requestAnimationFrame(tick);
  }

  function showGrave(whichSide){
    const yg=$('arenaYouGrave'),og=$('arenaOppGrave');
    if(whichSide==='you'){if(yg) yg.style.display='block';}
    else{if(og) og.style.display='block';}
  }

  // Public UI hooks (called by inline onclicks in Game.html)
  window.openArenaMenu=async function(){
    showArena();
    setView('menu');
    setWarn('');
    setStatus('Verbinde…');
    setButtons({searchVisible:true,cancelVisible:false,searchDisabled:true});

    if(!window.ArenaNet){
      setWarn('ArenaNet nicht geladen.');
      setButtons({searchVisible:true,cancelVisible:false,searchDisabled:true});
      return;
    }

    const ok=await ArenaNet.connect();
    if(ok){
      setStatus('Bereit. Suche einen Gegner.');
      setButtons({searchVisible:true,cancelVisible:false,searchDisabled:false});
    }else{
      setStatus('');
      setWarn('Arena benötigt den Node-Server. Starte `npm start` und öffne dann die URL, die der Server ausgibt (z.B. `http://localhost:3000`).');
      setButtons({searchVisible:true,cancelVisible:false,searchDisabled:true});
    }
  };

  window.closeArenaMenu=function(){
    // Leave queue if needed to satisfy safety requirement.
    try{ if(window.ArenaNet) ArenaNet.leaveQueue(); }catch{}
    hideArena();
  };

  window.arenaSearch=async function(){
    const chk=ensureReadyForArena();
    if(!chk.ok){
      setWarn(chk.reason);
      return;
    }
    setWarn('');
    setStatus('Suche nach Spieler…');
    setButtons({searchVisible:false,cancelVisible:true,searchDisabled:false});
    await ArenaNet.joinQueue();
  };

  window.arenaCancelSearch=function(){
    ArenaNet.leaveQueue();
    setStatus('Suche abgebrochen.');
    setButtons({searchVisible:true,cancelVisible:false,searchDisabled:false});
  };

  // Socket event wiring
  function wireNet(){
    if(!window.ArenaNet) return;
    let rollChain=Promise.resolve();

    ArenaNet.on('connected',()=>{ if(st.open) setStatus('Bereit. Suche einen Gegner.'); });
    ArenaNet.on('disconnected',({reason})=>{
      if(!st.open) return;
      setView('menu');
      setButtons({searchVisible:true,cancelVisible:false,searchDisabled:true});
      setStatus('');
      setWarn('Verbindung verloren ('+reason+'). Stelle sicher, dass der Server läuft.');
    });

    ArenaNet.on('queued',()=>{
      if(!st.open) return;
      setStatus('In Queue… warte auf Gegner.');
      setButtons({searchVisible:false,cancelVisible:true,searchDisabled:false});
    });
    ArenaNet.on('queue_left',()=>{
      if(!st.open) return;
      setStatus('Queue verlassen.');
      setButtons({searchVisible:true,cancelVisible:false,searchDisabled:false});
    });

    ArenaNet.on('matched',({opponentId})=>{
      if(!st.open) showArena();
      setView('match');
      resetMatchUI();
      st.opponentId=opponentId||null;
    });

    ArenaNet.on('request_state',()=>{
      if(!hasGameState()){ArenaNet.submitState({error:'NO_STATE'});return;}
      ArenaNet.submitState(snapshotState());
    });

    ArenaNet.on('wheel',({roundIndex,aOdds,winner,roundNum})=>{
      rollChain=rollChain.then(async ()=>{
        const me=ArenaNet.selfId;
        const idx=Number(roundIndex||0);
        const odds=Math.round(Number(aOdds||0.5)*100);
        if(idx<0||idx>2) return;

        const youRow=$('arenaYouDice'),oppRow=$('arenaOppDice');
        const youDie=youRow?youRow.querySelector('.arena-die[data-idx="'+idx+'"]'):null;
        const oppDie=oppRow?oppRow.querySelector('.arena-die[data-idx="'+idx+'"]'):null;

        const youWon=(winner === me);
        if(youWon) st.wheelRounds.a++;
        else st.wheelRounds.b++;
        
        // Show round number
        const res=$('arenaResult');
        if(res) res.textContent='Runde '+roundNum+'/3';

        await animateDie(youDie,youWon?odds:100-odds);
        await wait(200);
        await animateDie(oppDie,youWon?100-odds:odds);
        updateTotals();
      });
    });

    ArenaNet.on('opponent_left',({message})=>{
      if(st.open) setResult('info',message||'Gegner hat verlassen. Du gewinnst automatisch…');
    });

    ArenaNet.on('result',({winnerId,totals,transfer,reason})=>{
      const me=ArenaNet.selfId;
      const youWin=(me && winnerId===me);

      if(youWin){
        setResult('win','🏆 SIEG! Du hast das Glücksrad gewonnen.');
        applyTransferIfWinner(transfer);
        showGrave('opp');
        spawnBlood('opp');
      }else{
        setResult('lose','💀 Niederlage. Das Glücksrad war dir nicht hold.');
        applyLossIfLoser();
        showGrave('you');
        spawnBlood('you');
      }

      // Update totals display if server provided them.
      if(totals && me){
        const myTotal=totals[me]||0;
        const oppTotal=Object.entries(totals).find(([k])=>k!==me)?.[1]||0;
        if(typeof myTotal==='number'){$('arenaYouTotal').textContent='Siege: '+myTotal+'/3';}
        if(typeof oppTotal==='number'){$('arenaOppTotal').textContent='Siege: '+oppTotal+'/3';}
      }

      if(reason && st.open){
        // Keep reason subtle in log; UI already shows result.
        if(typeof window.addLog==='function') addLog('Arena: Glücksrad-'+reason,'li');
      }
    });

    ArenaNet.on('error',({message})=>{
      if(!st.open) return;
      setWarn(message||'Arena-Fehler');
      setButtons({searchVisible:true,cancelVisible:false,searchDisabled:false});
      setView('menu');
    });
  }

  // Initialize.
  wireNet();
  window.addEventListener('resize',()=>{ if(st.open) paintArenaBackdrop(); });
})();

