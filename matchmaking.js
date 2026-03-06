/* Multiplayer matchmaking + socket transport.
   This file owns the socket connection and emits high-level events for arena.js. */

(function(){
  function wait(ms){return new Promise(r=>setTimeout(r,ms));}

  function resolveArenaServerUrl(){
    try{
      const u=new URL(window.location.href);
      const fromQs=u.searchParams.get('arenaServer');
      if(fromQs){
        localStorage.setItem('ARENA_SERVER_URL',fromQs);
      }
    }catch{}
    const fromLs=(()=>{try{return localStorage.getItem('ARENA_SERVER_URL')||'';}catch{return'';}})();
    const fromGlobal=(typeof window.ARENA_SERVER_URL==='string'?window.ARENA_SERVER_URL:'')||'';
    return (fromGlobal||fromLs||window.location.origin).replace(/\/$/,'');
  }

  async function loadSocketIoClient(){
    if(window.io) return true;
    // Try to load from the same origin first (works when the Node server serves the page),
    // then fall back to a CDN (works when hosting the page separately, e.g. Vercel).
    const tryLoad=(src)=>new Promise((resolve)=>{
      const s=document.createElement('script');
      s.src=src;
      s.async=true;
      s.onload=()=>resolve(true);
      s.onerror=()=>resolve(false);
      document.head.appendChild(s);
    });
    if(await tryLoad('/socket.io/socket.io.js')) return true;
    return await tryLoad('https://cdn.socket.io/4.8.3/socket.io.min.js');
  }

  class ArenaNetClient{
    constructor(){
      this.socket=null;
      this.connected=false;
      this.selfId=null;
      this.roomId=null;
      this.inQueue=false;
      this.inMatch=false;
      this._handlers=new Map();
      this._connectPromise=null;
    }

    on(evt,fn){
      const arr=this._handlers.get(evt)||[];
      arr.push(fn);
      this._handlers.set(evt,arr);
      return ()=>this.off(evt,fn);
    }
    off(evt,fn){
      const arr=this._handlers.get(evt)||[];
      this._handlers.set(evt,arr.filter(x=>x!==fn));
    }
    _emit(evt,payload){
      const arr=this._handlers.get(evt)||[];
      for(const fn of arr){
        try{fn(payload);}catch(e){console.error('[ArenaNet]',evt,e);}
      }
    }

    async connect(){
      if(this.socket && this.connected) return true;
      if(this._connectPromise) return this._connectPromise;

      this._connectPromise=(async ()=>{
        const ok=await loadSocketIoClient();
        if(!ok || !window.io){
          this._emit('error',{code:'NO_SOCKET_IO',message:'Socket.io client konnte nicht geladen werden. Starte den Node-Server (npm start) und öffne das Spiel über die Server-URL (z.B. http://localhost:3000 — oder den Port, den der Server ausgibt).'});
          this._connectPromise=null;
          return false;
        }

        // If this file is opened directly (file://), socket.io can’t load from /socket.io/...
        // In that case, we expect the user to run the provided server and open via that server URL.
        // For split-hosting (Vercel + separate server), set `?arenaServer=https://YOUR_SERVER` once.
        const serverUrl=resolveArenaServerUrl();
        this.socket=window.io(serverUrl,{
          path:'/socket.io',
          transports:['websocket','polling'],
          reconnection:true,
          reconnectionAttempts:Infinity,
          reconnectionDelay:500,
          timeout:7000
        });

        this.socket.on('connect',()=>{
          this.connected=true;
          this.selfId=this.socket.id;
          this._emit('connected',{id:this.selfId});
        });
        this.socket.on('disconnect',(reason)=>{
          this.connected=false;
          this._emit('disconnected',{reason});
          // Reset queue/match state locally; server will clean up.
          this.inQueue=false;
          this.inMatch=false;
          this.roomId=null;
        });

        this.socket.on('arena:queued',()=>{
          this.inQueue=true;
          this._emit('queued',{});
        });
        this.socket.on('arena:queue_left',()=>{
          this.inQueue=false;
          this._emit('queue_left',{});
        });
        this.socket.on('arena:matched',({roomId,opponentId})=>{
          this.inQueue=false;
          this.inMatch=true;
          this.roomId=roomId;
          this._emit('matched',{roomId,opponentId});
        });
        this.socket.on('arena:request_state',()=>{
          // arena.js should answer with a current gs snapshot.
          this._emit('request_state',{});
        });
        this.socket.on('arena:roll',({by,value,rollIndex})=>{
          this._emit('roll',{by,value,rollIndex});
        });
        this.socket.on('arena:result',(payload)=>{
          this.inMatch=false;
          this._emit('result',payload);
        });
        this.socket.on('arena:opponent_left',({message})=>{
          this._emit('opponent_left',{message:message||'Opponent left'});
        });
        this.socket.on('arena:error',({message,code})=>{
          this._emit('error',{code:code||'SERVER_ERROR',message:message||'Arena error'});
        });

        // Give the socket a moment to connect (helps UX for first click).
        for(let i=0;i<14;i++){
          if(this.connected) break;
          await wait(120);
        }

        this._connectPromise=null;
        return this.connected;
      })();

      return this._connectPromise;
    }

    async joinQueue(){
      if(this.inQueue){this._emit('error',{code:'ALREADY_QUEUED',message:'Du bist bereits in der Queue.'});return;}
      if(this.inMatch){this._emit('error',{code:'IN_MATCH',message:'Du bist bereits in einem Arena-Match.'});return;}
      const ok=await this.connect();
      if(!ok || !this.socket) return;
      this.socket.emit('arena:queue_join');
    }

    leaveQueue(){
      if(!this.socket) return;
      if(!this.inQueue) return;
      this.socket.emit('arena:queue_leave');
    }

    submitState(state){
      if(!this.socket) return;
      if(!this.inMatch || !this.roomId) return;
      this.socket.emit('arena:state',state);
    }
  }

  window.ArenaNet=new ArenaNetClient();
})();

