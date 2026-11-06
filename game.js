(() => {
  'use strict';
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const W = canvas.width, H = canvas.height, WORLD = 3900, GROUND = 608;
  const SAVE_KEY = 'starwind-adventure-v2';
  const OLD_SAVE_KEY = 'starwind-adventure-v1';
  const catalog = {
    weapon: {
      wood: {name:'旅行短剑', bonus:0, text:'初始武器 · 攻击 +0'},
      star: {name:'星芒剑', bonus:1, text:'稀有 · 攻击 +1'},
      storm: {name:'风暴刃', bonus:2, text:'史诗 · 攻击 +2'}
    },
    armor: {
      cloth: {name:'旅人斗篷', bonus:0, text:'初始护甲 · 生命 +0'},
      leaf: {name:'绿叶甲', bonus:1, text:'稀有 · 生命 +1'},
      meteor: {name:'星陨甲', bonus:2, text:'史诗 · 生命 +2'}
    },
    pet: {
      fox: {name:'星狐', text:'自动攻击附近怪物'},
      rabbit: {name:'月兔', text:'定期恢复 1 点生命'},
      wisp: {name:'云灵', text:'定期补充星光能量'}
    }
  };
  const drawPool = [['weapon','star'],['weapon','star'],['weapon','storm'],['armor','leaf'],['armor','leaf'],['armor','meteor'],['pet','rabbit'],['pet','rabbit'],['pet','wisp'],['pet','wisp']];
  const keys = new Set();
  const platforms = [
    {x:330,y:500,w:175},{x:620,y:445,w:190},{x:1010,y:515,w:190},
    {x:1380,y:460,w:195},{x:1750,y:510,w:180},{x:2080,y:440,w:190},
    {x:2460,y:500,w:180},{x:2820,y:455,w:195},{x:3180,y:505,w:180}
  ];
  const hazards = [{x:920,w:82},{x:1600,w:90},{x:2350,w:82},{x:3060,w:95}];
  const enemySeeds = [
    ['slime',480],['slime',750],['bat',1060],['slime',1230],['bat',1490],
    ['slime',1830],['slime',2110],['bat',2250],['slime',2620],['bat',2810],
    ['slime',3020],['slime',3260],['boss',3540]
  ];
  let state = 'title', camera = 0, shake = 0, freeze = 0, time = 0, message = '', messageTimer = 0;
  let player, enemies, particles, drops, bolts, checkpoint, totalKills, audio, soundOn = true, petTimer = 0;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || localStorage.getItem(OLD_SAVE_KEY) || 'null'); } catch { saved = null; }
  const rnd = (a,b) => a + Math.random() * (b-a);
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const overlap = (a,b) => a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y;
  const groundOf = e => e.type === 'bat' ? 420 : GROUND-e.h;

  function makeEnemy(type,x,id) {
    const boss = type === 'boss', bat = type === 'bat';
    const w = boss ? 106 : bat ? 50 : 52, h = boss ? 116 : bat ? 42 : 42;
    return {id,type,x,y:boss ? GROUND-h : bat ? 415 : GROUND-h,w,h,vx:0,vy:0,
      hp:boss?28:bat?3:4,maxHp:boss?28:bat?3:4,dir:-1,hurt:0,
      attack:0,phase:rnd(0,6),home:x,hitSet:new Set()};
  }
  function freshGame(useSave=true) {
    const data = useSave && saved && !saved.won ? saved : null;
    const meta = saved || {};
    const owned = {
      weapon: ['wood',...(meta.owned?.weapon||[]).filter(id=>catalog.weapon[id]&&id!=='wood')],
      armor: ['cloth',...(meta.owned?.armor||[]).filter(id=>catalog.armor[id]&&id!=='cloth')],
      pet: ['fox',...(meta.owned?.pet||[]).filter(id=>catalog.pet[id]&&id!=='fox')]
    };
    const equipped = {
      weapon: owned.weapon.includes(meta.equipped?.weapon)?meta.equipped.weapon:'wood',
      armor: owned.armor.includes(meta.equipped?.armor)?meta.equipped.armor:'cloth',
      pet: owned.pet.includes(meta.equipped?.pet)?meta.equipped.pet:'fox'
    };
    checkpoint = data?.checkpoint === 1900 ? 1900 : 100;
    totalKills = data?.kills || 0;
    player = {x:checkpoint,y:GROUND-60,w:38,h:60,vx:0,vy:0,dir:1,hp:6,maxHp:6,
      level:clamp(Number(meta.level)||1,1,30),xp:Math.max(0,Number(meta.xp)||0),owned,equipped,
      meter:0,coins:Math.max(0,Number(meta.coins)||0),onGround:false,coyote:0,jumpBuffer:0,jumps:0,
      dash:0,dashCooldown:0,invuln:0,attack:0,attackCooldown:0,combo:0,attackHits:new Set()};
    player.maxHp=maxHealth();player.hp=player.maxHp;
    enemies = enemySeeds.map(([type,x],id)=>makeEnemy(type,x,id)).filter(e=>!data?.defeated?.includes(e.id));
    particles=[]; drops=[]; bolts=[];petTimer=0;camera=clamp(player.x-250,0,WORLD-W);
    if (data) toast('已继续上次进度');
  }
  function maxHealth(){return 6+Math.floor((player.level-1)/3)+catalog.armor[player.equipped.armor].bonus;}
  function attackPower(){return 2+Math.floor((player.level-1)/3)+catalog.weapon[player.equipped.weapon].bonus;}
  function xpNeeded(){return 45+player.level*30;}
  function saveProgress(won=false) {
    const defeated = enemySeeds.map((_,id)=>id).filter(id=>!enemies.some(e=>e.id===id));
    saved = {checkpoint,kills:totalKills,coins:player.coins,defeated,won,
      level:player.level,xp:player.xp,owned:player.owned,equipped:player.equipped};
    try { localStorage.setItem(SAVE_KEY,JSON.stringify(saved)); } catch { /* private mode */ }
  }
  function gainXp(amount){
    player.xp+=amount;
    while(player.level<30&&player.xp>=xpNeeded()){
      player.xp-=xpNeeded();player.level++;player.maxHp=maxHealth();player.hp=player.maxHp;
      toast(`升级！现在是 ${player.level} 级，生命已恢复`);
      puff(player.x+18,player.y+25,'#ffe68f',28,270);sound(900,.34,'triangle',.07);
    }
    if(player.level===30)player.xp=0;
  }
  function toast(text){message=text;messageTimer=2.5;}
  function sound(freq=440,duration=.08,type='sine',vol=.045){
    if(!soundOn) return;
    try {
      audio ||= new (window.AudioContext||window.webkitAudioContext)();
      if(audio.state==='suspended') audio.resume();
      const osc=audio.createOscillator(), gain=audio.createGain(), now=audio.currentTime;
      osc.type=type;osc.frequency.setValueAtTime(freq,now);osc.frequency.exponentialRampToValueAtTime(Math.max(80,freq*.55),now+duration);
      gain.gain.setValueAtTime(vol,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration);
      osc.connect(gain).connect(audio.destination);osc.start(now);osc.stop(now+duration);
    } catch { /* audio is optional */ }
  }
  function puff(x,y,color,n=12,power=240){
    for(let i=0;i<n;i++) particles.push({x,y,vx:rnd(-power,power),vy:rnd(-power,power),life:rnd(.25,.65),max:.65,size:rnd(3,8),color});
  }
  function setOverlay(kicker,title,text,button,icon='✦'){
    document.getElementById('overlay-kicker').textContent=kicker;
    document.getElementById('overlay-title').textContent=title;
    document.getElementById('overlay-text').textContent=text;
    document.getElementById('start').textContent=button;
    document.getElementById('overlay-icon').textContent=icon;
    overlay.hidden=false;
  }
  function start(){
    if(state==='title'||state==='won') {freshGame(state!=='won');saveProgress();}
    if(state==='dead') { player.x=checkpoint;player.y=GROUND-player.h;player.vx=player.vy=0;player.hp=player.maxHp;player.invuln=2; }
    state='playing';overlay.hidden=true;canvas.focus();sound(670,.15,'triangle');
  }
  document.getElementById('start').addEventListener('click',start);
  document.getElementById('pause').addEventListener('click',()=>togglePause());
  document.getElementById('sound').addEventListener('click',()=>{
    soundOn=!soundOn;document.getElementById('sound').textContent=soundOn?'♫ 音效开':'♫ 音效关';
  });
  const collection=document.getElementById('collection');
  function renderCollection(){
    document.getElementById('collection-stats').textContent=`LV ${player.level} · 经验 ${player.xp}/${xpNeeded()} · ♥ ${player.hp}/${player.maxHp} · ✦ ${player.coins} 星币 · 攻击 ${attackPower()}`;
    for(const type of ['weapon','armor','pet']){
      const list=document.getElementById(type==='weapon'?'weapon-list':type==='armor'?'armor-list':'pet-list');
      list.replaceChildren();
      for(const [id,item] of Object.entries(catalog[type])){
        const button=document.createElement('button'),name=document.createElement('strong'),detail=document.createElement('span');
        const own=player.owned[type].includes(id),active=player.equipped[type]===id;
        button.type='button';button.className='item-card'+(active?' equipped':'');button.disabled=!own||active;
        name.textContent=(active?'✓ ':'')+item.name;detail.textContent=own?item.text:'尚未获得 · 可通过抽奖获取';
        button.append(name,detail);
        button.addEventListener('click',()=>{
          const previous=player.maxHp;player.equipped[type]=id;
          if(type==='armor'){player.maxHp=maxHealth();player.hp=clamp(player.hp+player.maxHp-previous,1,player.maxHp);}
          if(type==='pet')petTimer=0;
          saveProgress();renderCollection();sound(720,.13,'triangle');
        });
        list.append(button);
      }
    }
    document.getElementById('draw').disabled=player.coins<12;
  }
  function toggleCollection(){
    if(state==='title')start();
    if(state==='playing'){state='menu';collection.hidden=false;renderCollection();document.getElementById('close-bag').focus();keys.clear();}
    else if(state==='menu'){state='playing';collection.hidden=true;canvas.focus();}
  }
  document.getElementById('bag').addEventListener('click',toggleCollection);
  document.getElementById('close-bag').addEventListener('click',toggleCollection);
  document.getElementById('draw').addEventListener('click',()=>{
    if(state!=='menu'||player.coins<12)return;
    player.coins-=12;
    const [type,id]=drawPool[Math.floor(Math.random()*drawPool.length)];
    const duplicate=player.owned[type].includes(id);
    if(duplicate)player.coins+=6;
    else player.owned[type].push(id);
    document.getElementById('draw-result').textContent=duplicate?`抽到重复的「${catalog[type][id].name}」，返还 6 星币。`:`获得「${catalog[type][id].name}」！在上方点击即可装备。`;
    saveProgress();renderCollection();sound(duplicate?480:1100,.26,'triangle',.07);
  });
  function togglePause(){
    if(state==='menu'){collection.hidden=true;state='playing';}
    if(state==='playing') {state='paused';setOverlay('稍作休息','游戏暂停','你的冒险会从这里继续。','继续冒险','Ⅱ');}
    else if(state==='paused') start();
  }
  const moveLeft=()=>keys.has('a')||keys.has('arrowleft');
  const moveRight=()=>keys.has('d')||keys.has('arrowright');
  window.addEventListener('keydown',e=>{
    const key=e.key.toLowerCase();
    if([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) e.preventDefault();
    if([' ','w','arrowup'].includes(key)&&!keys.has(key)&&state==='playing') player.jumpBuffer=.14;
    if(key==='p'&&!e.repeat) togglePause();
    if((key==='b'||key==='escape')&&!e.repeat&&(state==='playing'||state==='menu')) toggleCollection();
    if(key==='j'&&!e.repeat&&state==='playing') attack();
    if(key==='k'&&!e.repeat&&state==='playing') dash();
    if(key==='l'&&!e.repeat&&state==='playing') special();
    keys.add(key);
  });
  window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur',()=>keys.clear());
  function attack(){
    if(player.attackCooldown>0||player.dash>0) return;
    player.combo=player.attack>0 ? (player.combo%3)+1 : (player.combo%3)+1;
    player.attack=.22;player.attackCooldown=.16;player.attackHits.clear();
    sound(player.combo===3?320:460,.09,'sawtooth',.035);
  }
  function dash(){
    if(player.dashCooldown>0||player.dash>0) return;
    player.dash=.2;player.dashCooldown=.7;player.vx=player.dir*900;player.vy=0;
    player.invuln=Math.max(player.invuln,.23);shake=5;puff(player.x+20,player.y+32,'#9af2ff',14,170);sound(250,.15,'triangle');
  }
  function special(){
    if(player.meter<100) {toast('击败怪物积攒星光后可释放爆发');return;}
    player.meter=0;player.invuln=Math.max(player.invuln,.45);shake=14;freeze=.08;
    puff(player.x+18,player.y+26,'#ffe89c',38,490);sound(820,.4,'sine',.09);
    for(const e of enemies){
      const dx=e.x+e.w/2-(player.x+player.w/2);
      if(Math.abs(dx)<310 && Math.abs(e.y-player.y)<230) hitEnemy(e,5+Math.floor(attackPower()/2),Math.sign(dx)||player.dir);
    }
    bolts=bolts.filter(b=>Math.abs(b.x-player.x)>310);
  }
  function hitEnemy(e,damage,dir){
    if(e.hp<=0||e.hurt>0) return;
    e.hp-=damage;e.hurt=.22;e.vx=dir*(e.type==='boss'?90:260);player.meter=clamp(player.meter+11,0,100);
    shake=Math.max(shake,e.type==='boss'?8:4);freeze=Math.max(freeze,.035);
    puff(e.x+e.w/2,e.y+e.h/2,e.type==='boss'?'#fdd09c':'#fff1b0',15,230);
    sound(e.type==='boss'?140:200,.11,'square',.035);
    if(e.hp<=0){
      totalKills++;player.meter=clamp(player.meter+8,0,100);
      gainXp(e.type==='boss'?140:e.type==='bat'?35:30);
      for(let i=0;i<(e.type==='boss'?18:3);i++) drops.push({x:e.x+e.w/2+rnd(-25,25),y:e.y+e.h/2+rnd(-20,20),vy:rnd(-130,-60),kind:'coin',life:20});
      if(e.type!=='boss' && (totalKills%4===0)) drops.push({x:e.x+e.w/2,y:e.y,vy:-120,kind:'heart',life:20});
      enemies=enemies.filter(item=>item!==e);saveProgress();
      if(e.type==='boss') {toast('守门巨灵已击败！前往右侧星门');sound(1020,.4,'triangle',.09);}
    }
  }
  function hurtPlayer(amount,from){
    if(player.invuln>0||player.dash>0||state!=='playing') return;
    player.hp-=amount;player.invuln=1.15;player.vx=(player.x<from?-1:1)*320;player.vy=-260;
    shake=12;puff(player.x+18,player.y+30,'#ff9e9d',16,250);sound(120,.23,'sawtooth',.06);
    if(player.hp<=0){player.hp=0;state='dead';setOverlay('别急，再来一次','冒险未结束','你会从最近点亮的旗帜继续，怪物进度也会保留。','重新出发','✧');}
  }
  function update(dt){
    time+=dt;if(messageTimer>0) messageTimer-=dt;if(shake>0) shake=Math.max(0,shake-35*dt);
    if(state!=='playing') return;
    if(freeze>0){freeze=Math.max(0,freeze-dt);return;}
    const p=player;
    p.invuln=Math.max(0,p.invuln-dt);p.attack=Math.max(0,p.attack-dt);p.attackCooldown=Math.max(0,p.attackCooldown-dt);
    p.dashCooldown=Math.max(0,p.dashCooldown-dt);p.jumpBuffer=Math.max(0,p.jumpBuffer-dt);
    const moving=(moveRight()?1:0)-(moveLeft()?1:0);
    if(moving) p.dir=moving;
    if(p.dash>0){p.dash=Math.max(0,p.dash-dt);p.vx=p.dir*900;p.vy=0;if(Math.random()<.7)puff(p.x+18,p.y+30,'#c6f5ff',1,80);}
    else {
      const target=moving*360, diff=target-p.vx, step=(moving?2600:3000)*dt;
      p.vx+=clamp(diff,-step,step);
      p.vy=Math.min(p.vy+1800*dt,1100);
      if(p.jumpBuffer>0 && (p.coyote>0||p.jumps<2)){
        p.vy=p.jumps===0?-720:-640;p.jumps++;p.coyote=0;p.jumpBuffer=0;p.onGround=false;
        puff(p.x+18,p.y+p.h,'#e9fff6',9,130);sound(p.jumps===1?540:700,.15,'triangle');
      }
      if(!keys.has(' ')&&!keys.has('w')&&!keys.has('arrowup')&&p.vy<-250)p.vy+=1250*dt;
    }
    const oldBottom=p.y+p.h;
    p.x=clamp(p.x+p.vx*dt,0,WORLD-p.w);p.y+=p.vy*dt;
    p.onGround=false;
    if(p.y+p.h>=GROUND && oldBottom<=GROUND+25 && p.vy>=0){p.y=GROUND-p.h;p.vy=0;p.onGround=true;}
    for(const pl of platforms){
      if(p.vy>=0 && oldBottom<=pl.y+8 && p.y+p.h>=pl.y && p.x+p.w>pl.x+6 && p.x<pl.x+pl.w-6){
        p.y=pl.y-p.h;p.vy=0;p.onGround=true;
      }
    }
    if(p.onGround){p.jumps=0;p.coyote=.1;}else p.coyote=Math.max(0,p.coyote-dt);
    for(const h of hazards){if(p.y+p.h>GROUND-20&&p.x+p.w>h.x+9&&p.x<h.x+h.w-9)hurtPlayer(1,h.x+h.w/2);}
    if(p.x>1880&&checkpoint!==1900){checkpoint=1900;saveProgress();toast('云杉谷地复活点已记录');sound(880,.3,'sine');}
    if(p.x>3790 && !enemies.some(e=>e.type==='boss')){
      state='won';saveProgress(true);setOverlay('冒险完成','星门已点亮',`击败 ${totalKills} 个怪物，收集 ${p.coins} 枚星币。再来一局刷新成绩吧！`,'再玩一次','★');sound(1040,.5,'triangle',.1);
    }
    if(p.attack>0){
      const reach=p.combo===3?125:100;
      const box={x:p.dir>0?p.x+p.w-4:p.x-reach+4,y:p.y-6,w:reach,h:p.h+20};
      for(const e of [...enemies]) if(!p.attackHits.has(e.id)&&overlap(box,e)){
        p.attackHits.add(e.id);hitEnemy(e,attackPower()+(p.combo===3?1:0),p.dir);
      }
    }
    petTimer-=dt;
    if(petTimer<=0){
      const pet=p.equipped.pet;
      if(pet==='fox'){
        const target=enemies.filter(e=>Math.abs(e.x-p.x)<270&&Math.abs(e.y-p.y)<170).sort((a,b)=>Math.abs(a.x-p.x)-Math.abs(b.x-p.x))[0];
        if(target){hitEnemy(target,1+Math.floor((p.level-1)/5),Math.sign(target.x-p.x)||p.dir);puff(target.x+target.w/2,target.y+20,'#ffd895',7,120);petTimer=1.6;}
        else petTimer=.5;
      }else if(pet==='rabbit'){
        if(p.hp<p.maxHp){p.hp++;puff(p.x+18,p.y+20,'#f7d3ed',10,130);sound(690,.16,'sine',.025);petTimer=9;}
        else petTimer=2;
      }else{p.meter=clamp(p.meter+9,0,100);puff(p.x+18,p.y,'#d9eeff',5,80);petTimer=3;}
    }
    for(const e of [...enemies]){
      e.hurt=Math.max(0,e.hurt-dt);e.attack=Math.max(0,e.attack-dt);e.phase+=dt;
      const dx=p.x-e.x, near=Math.abs(dx)<460;
      if(e.type==='boss'){
        if(near&&e.attack<=0){
          e.attack=2.1;bolts.push({x:e.x+(dx<0?0:e.w),y:e.y+46,vx:dx<0?-360:360,life:3});
          sound(165,.25,'sawtooth',.025);
        }
        e.vx=near?Math.sign(dx)*95:0;e.x=clamp(e.x+e.vx*dt,3350,3680);
      } else if(e.type==='bat'){
        e.x+=clamp(dx,-1,1)*(near?125:0)*dt;
        e.y=clamp(e.y+(near?Math.sign(p.y-e.y)*70:0)*dt+Math.sin(e.phase*5)*.8,300,GROUND-85);
      } else {
        const dir=near?Math.sign(dx):Math.sin(e.phase*.9)>0?1:-1;
        e.vx=clamp(e.vx+dir*480*dt,-110,110);e.x+=e.vx*dt;e.y=GROUND-e.h;
        if(!near)e.x=clamp(e.x,e.home-100,e.home+100);
      }
      if(overlap(p,e)) hurtPlayer(e.type==='boss'?2:1,e.x+e.w/2);
    }
    for(const b of bolts){b.x+=b.vx*dt;b.life-=dt;if(overlap(p,{x:b.x-10,y:b.y-10,w:20,h:20})){b.life=0;hurtPlayer(1,b.x);}}
    bolts=bolts.filter(b=>b.life>0);
    for(const d of drops){
      d.vy+=500*dt;d.y=Math.min(GROUND-20,d.y+d.vy*dt);
      const dx=p.x+p.w/2-d.x,dy=p.y+p.h/2-d.y;
      if(dx*dx+dy*dy<120*120){d.x+=dx*dt*6;d.y+=dy*dt*6;}
      if(dx*dx+dy*dy<32*32){
        d.life=0;if(d.kind==='heart')p.hp=Math.min(p.maxHp,p.hp+1);else p.coins++;
        sound(d.kind==='heart'?700:900,.09,'sine',.025);saveProgress();
      }
      d.life-=dt;
    }
    drops=drops.filter(d=>d.life>0);
    for(const q of particles){q.x+=q.vx*dt;q.y+=q.vy*dt;q.vy+=400*dt;q.life-=dt;}
    particles=particles.filter(q=>q.life>0).slice(-250);
    camera+=((clamp(p.x-W*.34,0,WORLD-W))-camera)*Math.min(1,dt*5);
  }
  function rounded(x,y,w,h,r,color){ctx.fillStyle=color;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();}
  function background(){
    const sky=ctx.createLinearGradient(0,0,0,H);sky.addColorStop(0,'#6caadb');sky.addColorStop(.62,'#b6e7e6');sky.addColorStop(1,'#e7f5dd');ctx.fillStyle=sky;ctx.fillRect(0,0,W,H);
    ctx.fillStyle='#fff7c6';ctx.beginPath();ctx.arc(990-camera*.055,128,50,0,Math.PI*2);ctx.fill();
    for(let i=0;i<10;i++){
      const x=((i*248+120-camera*.18)%(W+400)+W+400)%(W+400)-170,y=88+(i%3)*52;
      ctx.globalAlpha=.7;rounded(x,y,128,24,14,'#fff');rounded(x+23,y-13,64,30,16,'#fff');ctx.globalAlpha=1;
    }
    ctx.fillStyle='#83bcc1';ctx.beginPath();ctx.moveTo(0,480);
    for(let x=0;x<=W+100;x+=80)ctx.lineTo(x,410+Math.sin((x+camera*.22)*.008)*35);
    ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.fill();
    ctx.fillStyle='#58998d';ctx.beginPath();ctx.moveTo(0,550);
    for(let x=0;x<=W+60;x+=60)ctx.lineTo(x,480+Math.sin((x+camera*.38)*.011)*35);
    ctx.lineTo(W,H);ctx.lineTo(0,H);ctx.fill();
    for(let i=0;i<23;i++){
      const x=i*190-camera*.68;
      if(x>-100&&x<W+100){
        const size=45+(i%4)*10;ctx.fillStyle='#356d64';ctx.fillRect(x-6,GROUND-95,12,110);
        ctx.fillStyle=i%3?'#397d6e':'#3e8873';ctx.beginPath();ctx.moveTo(x,GROUND-190-size);ctx.lineTo(x-size*.65,GROUND-82);ctx.lineTo(x+size*.65,GROUND-82);ctx.fill();
        ctx.fillStyle='#5d9d7d';ctx.beginPath();ctx.moveTo(x,GROUND-170-size);ctx.lineTo(x-size*.55,GROUND-106);ctx.lineTo(x+size*.55,GROUND-106);ctx.fill();
      }
    }
  }
  function scenery(){
    ctx.fillStyle='#405f59';ctx.fillRect(0,GROUND,WORLD,H-GROUND);
    ctx.fillStyle='#69aa70';ctx.fillRect(0,GROUND,WORLD,15);
    ctx.fillStyle='#98d388';ctx.fillRect(0,GROUND,WORLD,5);
    for(let i=0;i<WORLD/75;i++){
      const x=i*75+18;ctx.fillStyle=i%3?'#658668':'#8b956c';ctx.fillRect(x,GROUND+34+(i%4)*18,9,5);
      ctx.fillStyle='#dcebb0';ctx.fillRect(x+25,GROUND-8,3,8);
      if(i%7===0){ctx.fillStyle='#f7dd84';ctx.beginPath();ctx.arc(x+28,GROUND-10,4,0,7);ctx.fill();}
    }
    for(const h of hazards){
      ctx.fillStyle='#684e50';ctx.fillRect(h.x,GROUND-3,h.w,10);
      for(let x=h.x;x<h.x+h.w-14;x+=16){ctx.fillStyle='#d6e8de';ctx.beginPath();ctx.moveTo(x,GROUND+2);ctx.lineTo(x+8,GROUND-22);ctx.lineTo(x+16,GROUND+2);ctx.fill();}
    }
    for(const pl of platforms){
      rounded(pl.x,pl.y,pl.w,24,9,'#8e7157');rounded(pl.x,pl.y-5,pl.w,11,5,'#77b674');
      ctx.fillStyle='#b5d99a';ctx.fillRect(pl.x+8,pl.y-7,pl.w-16,3);
      for(let x=pl.x+35;x<pl.x+pl.w-20;x+=55){ctx.fillStyle='#597d5b';ctx.fillRect(x,pl.y+10,5,8);}
    }
    for(const x of [1900,3780]){
      ctx.fillStyle='#796855';ctx.fillRect(x,GROUND-112,8,112);
      ctx.fillStyle=x===1900&&checkpoint===1900?'#ffe392':'#9ce9e5';
      ctx.beginPath();ctx.moveTo(x+8,GROUND-110);ctx.lineTo(x+65,GROUND-94);ctx.lineTo(x+8,GROUND-76);ctx.fill();
      if(x===3780){ctx.strokeStyle='#b8f6ec';ctx.lineWidth=9;ctx.beginPath();ctx.ellipse(x+40,GROUND-63,39,61,0,0,7);ctx.stroke();ctx.fillStyle='#c6fff0';ctx.globalAlpha=.22;ctx.fill();ctx.globalAlpha=1;}
    }
  }
  function drawPlayer(){
    const p=player;if(p.invuln>0&&Math.floor(time*15)%2===0)return;
    ctx.save();ctx.translate(p.x+p.w/2,p.y+p.h/2);ctx.scale(p.dir,1);
    const bob=p.onGround?Math.sin(time*15)*Math.min(3,Math.abs(p.vx)/100):0;
    ctx.fillStyle='#283e54';ctx.fillRect(-13,15+bob,11,19);ctx.fillRect(3,15+bob,11,19);
    rounded(-17,-6+bob,34,32,9,'#5378b6');rounded(-11,0+bob,22,18,6,'#7ab0db');
    ctx.fillStyle='#f1c4a4';ctx.beginPath();ctx.arc(0,-19+bob,16,0,7);ctx.fill();
    ctx.fillStyle='#354b75';ctx.beginPath();ctx.arc(-3,-26+bob,17,Math.PI,Math.PI*2);ctx.fill();
    ctx.fillRect(-19,-31+bob,37,9);ctx.fillStyle='#253952';ctx.fillRect(5,-19+bob,3,3);
    ctx.fillStyle='#ffd58e';ctx.fillRect(-18,-8+bob,7,12);
    if(p.attack>0){
      ctx.strokeStyle=p.combo===3?'#fff0aa':'#c7f9ff';ctx.lineWidth=p.combo===3?18:12;ctx.lineCap='round';
      ctx.beginPath();ctx.arc(14,-2,58,-1.1,1.05);ctx.stroke();
      ctx.fillStyle='#e7faff';ctx.fillRect(14,1,55,7);
    }else{ctx.fillStyle='#e4eff5';ctx.fillRect(15,-2,27,5);ctx.fillStyle='#e8b864';ctx.fillRect(12,-4,6,9);}
    ctx.restore();
  }
  function drawPet(){
    const p=player,id=p.equipped.pet,x=p.x-38+Math.sin(time*3)*6,y=p.y+15+Math.sin(time*5)*7;
    ctx.save();ctx.translate(x,y);
    ctx.shadowBlur=14;ctx.shadowColor=id==='fox'?'#ffcc88':id==='rabbit'?'#ffd0eb':'#bdeaff';
    ctx.fillStyle=id==='fox'?'#f2a865':id==='rabbit'?'#f6e8f1':'#bbecfa';
    ctx.beginPath();ctx.ellipse(0,0,15,13,0,0,7);ctx.fill();ctx.shadowBlur=0;
    if(id==='fox'){ctx.beginPath();ctx.moveTo(-12,-8);ctx.lineTo(-10,-22);ctx.lineTo(-2,-11);ctx.moveTo(5,-10);ctx.lineTo(12,-22);ctx.lineTo(13,-5);ctx.fill();}
    if(id==='rabbit'){ctx.fillRect(-9,-28,6,19);ctx.fillRect(4,-28,6,19);}
    if(id==='wisp'){ctx.fillStyle='#eaf9ff';ctx.beginPath();ctx.moveTo(-5,9);ctx.lineTo(0,25);ctx.lineTo(6,9);ctx.fill();}
    ctx.fillStyle='#34435b';ctx.fillRect(-6,-2,3,3);ctx.fillRect(5,-2,3,3);ctx.restore();
  }
  function drawEnemy(e){
    ctx.save();ctx.translate(e.x,e.y);if(e.hurt>0)ctx.globalAlpha=.5+Math.sin(time*50)*.25;
    if(e.type==='slime'){
      ctx.fillStyle='#477a5b';ctx.beginPath();ctx.ellipse(26,35,26,8,0,0,7);ctx.fill();
      ctx.fillStyle='#8bd587';ctx.beginPath();ctx.moveTo(1,37);ctx.quadraticCurveTo(2,1,25,5+Math.sin(e.phase*7)*2);ctx.quadraticCurveTo(54,5,51,37);ctx.quadraticCurveTo(25,51,1,37);ctx.fill();
      ctx.fillStyle='#386458';ctx.fillRect(17,23,4,6);ctx.fillRect(33,23,4,6);ctx.fillStyle='#f4aa9e';ctx.fillRect(25,31,5,3);
    }else if(e.type==='bat'){
      ctx.fillStyle='#655c9b';ctx.beginPath();ctx.moveTo(25,15);ctx.lineTo(1,4+Math.sin(e.phase*12)*8);ctx.lineTo(7,32);ctx.lineTo(25,26);ctx.lineTo(43,32);ctx.lineTo(49,4+Math.sin(e.phase*12)*8);ctx.closePath();ctx.fill();
      ctx.fillStyle='#8e79b7';ctx.beginPath();ctx.arc(25,20,14,0,7);ctx.fill();ctx.fillStyle='#fef2d1';ctx.fillRect(18,17,4,4);ctx.fillRect(29,17,4,4);
    }else{
      rounded(5,15,96,96,18,'#695e75');rounded(17,7,72,60,19,'#8d7890');
      ctx.fillStyle='#b7a1a3';ctx.fillRect(2,45,15,42);ctx.fillRect(89,45,15,42);
      ctx.fillStyle='#f7c78b';ctx.fillRect(31,35,13,8);ctx.fillRect(62,35,13,8);
      ctx.fillStyle='#e9d8b6';ctx.beginPath();ctx.moveTo(38,6);ctx.lineTo(31,-13);ctx.lineTo(51,8);ctx.lineTo(68,-13);ctx.lineTo(76,9);ctx.fill();
      rounded(10,-21,86,8,4,'#273a4b');rounded(12,-19,82*(e.hp/e.maxHp),4,2,'#ff9b85');
    }
    ctx.restore();
  }
  function hud(){
    rounded(20,18,265,124,15,'#15273dcc');
    ctx.fillStyle='#fff';ctx.font='bold 15px system-ui';ctx.fillText(`星风旅人  LV ${player.level}`,37,45);
    for(let i=0;i<player.maxHp;i++){ctx.fillStyle=i<player.hp?'#ff8d99':'#536272';ctx.font='25px system-ui';ctx.fillText('♥',36+i*32,78);}
    rounded(36,91,220,10,5,'#455c6c');rounded(36,91,220*player.meter/100,10,5,'#ffdb82');
    rounded(36,112,220,7,4,'#455c6c');rounded(36,112,220*player.xp/xpNeeded(),7,4,'#91d4f5');
    ctx.font='bold 13px system-ui';ctx.fillStyle='#f9e0a1';ctx.fillText(`✦ ${player.coins} 星币`,W-128,42);
    rounded(W-274,52,248,9,5,'#2d5361aa');rounded(W-274,52,248*(player.x/WORLD),9,5,'#ffdc92');
    ctx.fillStyle='#e8f7f2';ctx.font='12px system-ui';ctx.fillText(`已击败 ${totalKills} / ${enemySeeds.length}    终点 →`,W-274,80);
    if(messageTimer>0){ctx.textAlign='center';rounded(W/2-220,130,440,46,12,'#17354bcc');ctx.fillStyle='#fff5d5';ctx.font='bold 18px system-ui';ctx.fillText(message,W/2,160);ctx.textAlign='left';}
    if(player.meter>=100){ctx.textAlign='center';ctx.fillStyle='#fff1b2';ctx.font='bold 18px system-ui';ctx.fillText('✦ 星光已满！按 L 释放爆发',W/2,H-35);ctx.textAlign='left';}
  }
  function render(){
    ctx.save();ctx.clearRect(0,0,W,H);background();
    const ox=shake>0?rnd(-shake,shake):0,oy=shake>0?rnd(-shake,shake):0;
    ctx.translate(-camera+ox,oy);scenery();
    for(const d of drops){ctx.fillStyle=d.kind==='heart'?'#ff8caa':'#ffd967';ctx.beginPath();ctx.arc(d.x,d.y,d.kind==='heart'?11:7,0,7);ctx.fill();}
    for(const b of bolts){ctx.fillStyle='#f8b9c4';ctx.shadowColor='#ff8faa';ctx.shadowBlur=18;ctx.beginPath();ctx.arc(b.x,b.y,11,0,7);ctx.fill();ctx.shadowBlur=0;}
    for(const e of enemies)drawEnemy(e);
    if(player){drawPet();drawPlayer();}
    for(const q of particles){ctx.globalAlpha=clamp(q.life/q.max,0,1);ctx.fillStyle=q.color;ctx.fillRect(q.x,q.y,q.size,q.size);ctx.globalAlpha=1;}
    ctx.restore();if(player)hud();
  }
  let previous=performance.now(),accumulator=0;
  function frame(now){
    const elapsed=Math.min((now-previous)/1000,.05);previous=now;accumulator+=elapsed;
    while(accumulator>=1/60){update(1/60);accumulator-=1/60;}
    render();requestAnimationFrame(frame);
  }
  freshGame();requestAnimationFrame(frame);
})();
