import express from 'express';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || path.join(root, 'velvet.db');
const db = new DatabaseSync(dbPath);
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const bloodDuelEntries = new Map();
const liveRooms = new Map();
const app = express();
app.use(express.json({ limit: '16kb' }));
app.get('/api/health',(_,res)=>res.json({ok:true,name:'BloodyJack'}));

db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  admin_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS game_stats (
  user_id INTEGER PRIMARY KEY,
  hands INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  blackjacks INTEGER NOT NULL DEFAULT 0,
  total_wagered REAL NOT NULL DEFAULT 0,
  gross_winnings REAL NOT NULL DEFAULT 0,
  biggest_win REAL NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_wallet_user_created ON wallet_transactions(user_id, created_at DESC);`);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(':');
  const derived = Buffer.from(await scrypt(password, salt, 64));
  const expectedBuffer = Buffer.from(expected, 'hex');
  return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
function publicUser(user) { return { id: user.id, username: user.username, email: user.email, role: user.role }; }
function currentUser(req) {
  const id = sessions.get(cookie(req, 'velvet_session'));
  return id ? db.prepare('SELECT id, username, email, role FROM users WHERE id = ?').get(id) : null;
}
function walletBalance(userId) { return Number(db.prepare('SELECT COALESCE(SUM(amount),0) balance FROM wallet_transactions WHERE user_id=?').get(userId).balance); }
function addWalletTransaction(userId, amount, type, reason, adminId=null) {
  db.prepare('INSERT INTO wallet_transactions(user_id,amount,type,reason,admin_id) VALUES(?,?,?,?,?)').run(userId, amount, type, reason, adminId);
  return walletBalance(userId);
}
function ensureWallet(userId) {
  const count = db.prepare('SELECT COUNT(*) count FROM wallet_transactions WHERE user_id=?').get(userId).count;
  if (!count) addWalletTransaction(userId, 2500, 'welcome', 'Başlangıç jetonu');
  db.prepare('INSERT OR IGNORE INTO game_stats(user_id) VALUES(?)').run(userId);
}
function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, userId);
  res.setHeader('Set-Cookie', `velvet_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
}
function roomView(room) { return { code:room.code, leaderId:room.leaderId, status:room.status, players:[...room.players.values()].map(({socketId,...player})=>player) }; }
function makeRoomCode() { let code; do code=crypto.randomBytes(3).toString('hex').toUpperCase(); while(liveRooms.has(code)); return code; }
const cardSuits=['♠','♥','♦','♣'],cardRanks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function shuffledDeck(){const deck=cardSuits.flatMap(suit=>cardRanks.map(rank=>({suit,rank})));for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]]}return deck}
function onlineHandValue(cards){let value=0,aces=0;for(const card of cards){if(card.rank==='A'){value+=11;aces++}else value+=['J','Q','K'].includes(card.rank)?10:Number(card.rank)}while(value>21&&aces){value-=10;aces--}return value}
function gameView(room){const game=room.game;if(!game)return null;return{phase:game.phase,activePlayerId:game.phase==='playing'?game.players[game.activeIndex]?.id:null,dealer:game.dealer.map((card,index)=>game.phase==='playing'&&index===1?{...card,hidden:true}:card),players:game.players.map(player=>({...player,total:onlineHandValue(player.hand)})),message:game.message}}
function beginOnlineGame(room){const deck=shuffledDeck(),players=[...room.players.values()].filter(p=>p.online).map(p=>({id:p.id,username:p.username,hand:[],status:'playing'})),dealer=[];for(let round=0;round<2;round++){for(const player of players)player.hand.push(deck.pop());dealer.push(deck.pop())}room.game={deck,players,dealer,activeIndex:0,phase:'playing',message:`Sıra ${players[0].username}`}}
function advanceOnlineTurn(room){const game=room.game;game.activeIndex++;while(game.activeIndex<game.players.length&&game.players[game.activeIndex].status!=='playing')game.activeIndex++;if(game.activeIndex<game.players.length){game.message=`Sıra ${game.players[game.activeIndex].username}`;return}while(onlineHandValue(game.dealer)<17)game.dealer.push(game.deck.pop());const dealerTotal=onlineHandValue(game.dealer);for(const player of game.players){const total=onlineHandValue(player.hand);if(total>21)player.result='YANDI';else if(dealerTotal>21||total>dealerTotal)player.result='KAZANDI';else if(total===dealerTotal)player.result='BERABERE';else player.result='KAYBETTİ'}game.phase='result';game.message=`Krupiye ${dealerTotal} • El tamamlandı`}

const adminEmail = 'admin@velvet.local';
if (!db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail)) {
  const passwordHash = await hashPassword(process.env.ADMIN_PASSWORD || 'velvet2026');
  db.prepare('INSERT INTO users (username,email,password_hash,role) VALUES (?,?,?,?)').run('Emir Admin', adminEmail, passwordHash, 'admin');
}
for (const row of db.prepare('SELECT id FROM users').all()) ensureWallet(row.id);

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (username.length < 3) return res.status(400).json({ error: 'Kullanıcı adı en az 3 karakter olmalı.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Geçerli bir e-posta gir.' });
  if (password.length < 8) return res.status(400).json({ error: 'Şifre en az 8 karakter olmalı.' });
  try {
    const result = db.prepare('INSERT INTO users (username,email,password_hash) VALUES (?,?,?)').run(username, email, await hashPassword(password));
    const user = db.prepare('SELECT id,username,email,role FROM users WHERE id=?').get(result.lastInsertRowid);
    ensureWallet(user.id);
    setSession(res, user.id); res.status(201).json({ user: publicUser(user) });
  } catch { res.status(409).json({ error: 'Bu e-posta zaten kayıtlı.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user || !await verifyPassword(String(req.body.password || ''), user.password_hash)) return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
  setSession(res, user.id); res.json({ user: publicUser(user) });
});
app.get('/api/auth/me', (req, res) => { const user=currentUser(req); user?res.json({user:publicUser(user)}):res.status(401).json({error:'Oturum yok.'}); });
app.post('/api/auth/logout', (req, res) => { const token=cookie(req,'velvet_session'); if(token)sessions.delete(token); res.setHeader('Set-Cookie','velvet_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ok:true}); });
app.get('/api/wallet', (req,res) => { const user=currentUser(req); if(!user)return res.status(401).json({error:'Oturum gerekli.'}); ensureWallet(user.id); const last=db.prepare("SELECT created_at FROM wallet_transactions WHERE user_id=? AND type='reward' ORDER BY id DESC LIMIT 1").get(user.id); const nextRewardAt=last?new Date(`${last.created_at}Z`).getTime()+600000:Date.now(); const transactions=db.prepare('SELECT id,amount,type,reason,created_at FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 20').all(user.id); res.json({balance:walletBalance(user.id),nextRewardAt,transactions}); });
app.post('/api/wallet/claim-reward', (req,res) => { const user=currentUser(req); if(!user)return res.status(401).json({error:'Oturum gerekli.'}); const last=db.prepare("SELECT created_at FROM wallet_transactions WHERE user_id=? AND type='reward' ORDER BY id DESC LIMIT 1").get(user.id); const nextAt=last?new Date(`${last.created_at}Z`).getTime()+600000:0; if(Date.now()<nextAt)return res.status(429).json({error:'Ödül henüz hazır değil.',nextRewardAt:nextAt}); const today=db.prepare("SELECT COUNT(*) count FROM wallet_transactions WHERE user_id=? AND type='reward' AND date(created_at)=date('now')").get(user.id).count; if(today>=10)return res.status(429).json({error:'Günlük ödül limitine ulaştın.'}); const balance=addWalletTransaction(user.id,25,'reward','10 dakikalık masa hediyesi'); res.json({balance,reward:25,nextRewardAt:Date.now()+600000,claimsToday:today+1}); });
app.post('/api/blood-duel/join', (req,res) => { const user=currentUser(req); if(!user)return res.status(401).json({error:'Oturum gerekli.'}); const stake=Number(req.body.stake),participants=Number(req.body.participants); if(![10000,50000,100000].includes(stake)||!Number.isInteger(participants)||participants<2||participants>5)return res.status(400).json({error:'Geçersiz düello seviyesi.'}); if(bloodDuelEntries.has(user.id))return res.status(409).json({error:'Zaten aktif bir Kan Düellon var.'}); if(walletBalance(user.id)<stake)return res.status(400).json({error:`Bu masa için en az ${stake.toLocaleString('tr-TR')} jeton gerekli.`}); const balance=addWalletTransaction(user.id,-stake,'blood_duel_entry',`Kan Düellosu giriş bedeli: ${stake}`); const prize=stake*participants; bloodDuelEntries.set(user.id,{stake,prize}); res.json({balance,stake,prize}); });
app.post('/api/blood-duel/settle', (req,res) => { const user=currentUser(req); if(!user)return res.status(401).json({error:'Oturum gerekli.'}); const entry=bloodDuelEntries.get(user.id); if(!entry)return res.status(409).json({error:'Aktif Kan Düellosu bulunamadı.'}); const won=Boolean(req.body.won); bloodDuelEntries.delete(user.id); const balance=won?addWalletTransaction(user.id,entry.prize,'blood_duel_prize',`Kan Düellosu büyük ödülü: ${entry.prize}`):walletBalance(user.id); res.json({balance,prize:won?entry.prize:0}); });
app.get('/api/stats', (req,res) => { const user=currentUser(req); if(!user)return res.status(401).json({error:'Oturum gerekli.'}); ensureWallet(user.id); const stats=db.prepare('SELECT * FROM game_stats WHERE user_id=?').get(user.id); res.json({stats:{...stats,balance:walletBalance(user.id),net_profit:Number(stats.gross_winnings)-Number(stats.total_wagered),win_rate:stats.hands?Math.round(stats.wins/stats.hands*1000)/10:0}}); });
app.post('/api/game/result', (req,res) => { const user=currentUser(req); if(!user)return res.status(401).json({error:'Oturum gerekli.'}); const wager=Number(req.body.wager),delta=Number(req.body.delta),result=String(req.body.result||''); const blackjack=Boolean(req.body.blackjack); if(!Number.isFinite(wager)||!Number.isFinite(delta)||wager<=0||Math.abs(delta)>wager*4)return res.status(400).json({error:'Geçersiz oyun sonucu.'}); const balance=walletBalance(user.id); if(wager>balance)return res.status(400).json({error:'Yetersiz bakiye.'}); const win=result==='win',loss=result==='loss',push=result==='push'; if(!win&&!loss&&!push)return res.status(400).json({error:'Geçersiz sonuç.'}); const nextBalance=addWalletTransaction(user.id,delta,'game',`Blackjack eli: ${result}`); db.prepare(`UPDATE game_stats SET hands=hands+1,wins=wins+?,losses=losses+?,pushes=pushes+?,blackjacks=blackjacks+?,total_wagered=total_wagered+?,gross_winnings=gross_winnings+?,biggest_win=MAX(biggest_win,?) WHERE user_id=?`).run(win?1:0,loss?1:0,push?1:0,blackjack?1:0,wager,delta>0?wager+delta:0,delta>0?delta:0,user.id); res.json({balance:nextBalance}); });
app.get('/api/admin/stats', (req, res) => { const user=currentUser(req); if(user?.role!=='admin')return res.status(403).json({error:'Yetkisiz.'}); const count=db.prepare('SELECT COUNT(*) count FROM users').get().count; const chips=db.prepare('SELECT COALESCE(SUM(amount),0) total FROM wallet_transactions').get().total; const hands=db.prepare('SELECT COALESCE(SUM(hands),0) total FROM game_stats').get().total; res.json({users:count,tables:1,status:'CANLI',chips,hands}); });
app.get('/api/admin/users', (req,res) => { const admin=currentUser(req); if(admin?.role!=='admin')return res.status(403).json({error:'Yetkisiz.'}); const users=db.prepare(`SELECT u.id,u.username,u.email,u.role,u.created_at,COALESCE(SUM(w.amount),0) balance,s.hands,s.wins,s.losses,s.gross_winnings,s.total_wagered FROM users u LEFT JOIN wallet_transactions w ON w.user_id=u.id LEFT JOIN game_stats s ON s.user_id=u.id GROUP BY u.id ORDER BY u.id DESC`).all(); res.json({users}); });
app.post('/api/admin/users/:id/adjust', (req,res) => { const admin=currentUser(req); if(admin?.role!=='admin')return res.status(403).json({error:'Yetkisiz.'}); const targetId=Number(req.params.id),amount=Number(req.body.amount),reason=String(req.body.reason||'').trim(); if(!Number.isFinite(amount)||amount===0||Math.abs(amount)>1000000)return res.status(400).json({error:'Geçersiz miktar.'}); if(reason.length<3)return res.status(400).json({error:'En az 3 karakterlik açıklama gerekli.'}); if(!db.prepare('SELECT id FROM users WHERE id=?').get(targetId))return res.status(404).json({error:'Kullanıcı bulunamadı.'}); const next=walletBalance(targetId)+amount;if(next<0)return res.status(400).json({error:'Bakiye sıfırın altına düşemez.'}); const balance=addWalletTransaction(targetId,amount,'admin',reason,admin.id);res.json({balance}); });

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get(/.*/, (_, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
const httpServer=createServer(app);
const io=new SocketServer(httpServer,{cors:{origin:true,credentials:true}});
io.use((socket,next)=>{const user=currentUser(socket.request);if(!user)return next(new Error('Oturum gerekli.'));socket.data.user=publicUser(user);next()});
io.on('connection',socket=>{
  const user=socket.data.user;
  const leaveCurrentRoom=()=>{const code=socket.data.roomCode;if(!code)return;const room=liveRooms.get(code);if(!room)return;const player=room.players.get(user.id);if(player){player.online=false;player.ready=false;player.socketId='';io.to(code).emit('room:update',roomView(room))}};
  socket.on('room:create',(_,reply=()=>{})=>{leaveCurrentRoom();const code=makeRoomCode();const room={code,leaderId:user.id,status:'lobby',players:new Map([[user.id,{id:user.id,username:user.username,ready:false,online:true,socketId:socket.id}]])};liveRooms.set(code,room);socket.data.roomCode=code;socket.join(code);reply({ok:true,room:roomView(room)});io.to(code).emit('room:update',roomView(room))});
  socket.on('room:join',({code}={},reply=()=>{})=>{code=String(code||'').trim().toUpperCase();const room=liveRooms.get(code);if(!room)return reply({ok:false,error:'Masa bulunamadı.'});if(room.status!=='lobby')return reply({ok:false,error:'Oyun başlamış.'});if(!room.players.has(user.id)&&room.players.size>=5)return reply({ok:false,error:'Masa dolu.'});leaveCurrentRoom();room.players.set(user.id,{id:user.id,username:user.username,ready:false,online:true,socketId:socket.id});socket.data.roomCode=code;socket.join(code);reply({ok:true,room:roomView(room)});io.to(code).emit('room:update',roomView(room))});
  socket.on('room:ready',(_,reply=()=>{})=>{const room=liveRooms.get(socket.data.roomCode),player=room?.players.get(user.id);if(!room||!player)return reply({ok:false,error:'Masada değilsin.'});player.ready=!player.ready;io.to(room.code).emit('room:update',roomView(room));reply({ok:true})});
  socket.on('room:start',(_,reply=()=>{})=>{const room=liveRooms.get(socket.data.roomCode);if(!room||room.leaderId!==user.id)return reply({ok:false,error:'Yalnızca masa lideri başlatabilir.'});const guests=[...room.players.values()].filter(p=>p.id!==room.leaderId);if(!guests.length)return reply({ok:false,error:'Başlamak için en az bir arkadaş gerekli.'});if(guests.some(p=>!p.ready||!p.online))return reply({ok:false,error:'Bütün oyuncular hazır ve çevrimiçi olmalı.'});room.status='playing';beginOnlineGame(room);io.to(room.code).emit('room:started',roomView(room));io.to(room.code).emit('room:update',roomView(room));io.to(room.code).emit('game:update',gameView(room));reply({ok:true})});
  socket.on('game:action',({action}={},reply=()=>{})=>{const room=liveRooms.get(socket.data.roomCode),game=room?.game;if(!room||!game||game.phase!=='playing')return reply({ok:false,error:'Aktif oyun yok.'});const player=game.players[game.activeIndex];if(player?.id!==user.id)return reply({ok:false,error:'Sıra sende değil.'});if(action==='hit'){player.hand.push(game.deck.pop());const total=onlineHandValue(player.hand);if(total>=21){player.status=total>21?'bust':'stand';advanceOnlineTurn(room)}}else if(action==='stand'){player.status='stand';advanceOnlineTurn(room)}else return reply({ok:false,error:'Geçersiz hamle.'});io.to(room.code).emit('game:update',gameView(room));reply({ok:true})});
  socket.on('game:next-round',(_,reply=()=>{})=>{const room=liveRooms.get(socket.data.roomCode);if(!room||room.leaderId!==user.id)return reply({ok:false,error:'Yeni eli yalnızca lider başlatabilir.'});beginOnlineGame(room);io.to(room.code).emit('game:update',gameView(room));reply({ok:true})});
  socket.on('disconnect',leaveCurrentRoom);
});
httpServer.listen(Number(process.env.PORT)||5173,'0.0.0.0',()=>console.log(`BloodyJack: http://127.0.0.1:${Number(process.env.PORT)||5173}`));
