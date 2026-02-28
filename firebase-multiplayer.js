// ═══════════════════════════════════════════════════════════════
//  STUDY QUEST PRO — MÓDULO MULTIJUGADOR FIREBASE v2
//  Fix: reconexión automática + keepalive (chat/desafíos siempre on)
//  Nuevo: Semana Infernal con grupos
// ═══════════════════════════════════════════════════════════════

const MP = {
    db: null,
    myId: null,
    _connected: false,
    _keepaliveInterval: null,
    _reconnectTimeout: null,
    friendListeners: {},
    chatListeners: {},
    _activeChallenges: {},
    _globalPlayers: {},
    _currentChatId: null,
    _pendingNotifiedIds: new Set(),
    _semanasInfernales: {},
    _myActiveHell: null,

    // ════════════════════════════════════════════════════════════
    //  INIT & RECONEXIÓN AUTOMÁTICA
    // ════════════════════════════════════════════════════════════
    init() {
        try {
            this.db = firebase.database();
            this.myId = this._getOrCreateId();
            console.log('[MP] Iniciado. ID:', this.myId);
            this._watchConnection();
            this._renderMyId();
        } catch (e) {
            console.error('[MP] Error al iniciar Firebase:', e);
        }
    },

    _getOrCreateId() {
        let id = localStorage.getItem('hvPlayerId');
        if (!id) {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            id = 'HV-' + Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
            localStorage.setItem('hvPlayerId', id);
        }
        return id;
    },

    _renderMyId() {
        const el = document.getElementById('my-player-id');
        if (el) el.textContent = this.myId;
    },

    // Monitoriza la conexión y reconecta listeners al volver online
    _watchConnection() {
        this.db.ref('.info/connected').on('value', snap => {
            const isConnected = snap.val() === true;
            const wasConnected = this._connected;
            this._connected = isConnected;

            const ind = document.getElementById('mp-connection-indicator');
            if (ind) {
                ind.textContent = isConnected ? '🟢 Online' : '🔴 Reconectando...';
                ind.className = isConnected ? 'mp-online' : 'mp-offline';
            }

            if (isConnected) {
                this._startPresence();
                this._updateMyProfile();
                if (!wasConnected) {
                    // Reconexión: re-registrar todos los listeners
                    this._reattachAllListeners();
                }
                this._startKeepalive();
                clearTimeout(this._reconnectTimeout);
            } else {
                this._stopKeepalive();
                // Si lleva 10s desconectado, forzar reconexión
                clearTimeout(this._reconnectTimeout);
                this._reconnectTimeout = setTimeout(() => {
                    if (!this._connected) {
                        console.log('[MP] Forzando reconexión...');
                        this.db.goOffline();
                        setTimeout(() => this.db.goOnline(), 1500);
                    }
                }, 10000);
            }
        });
    },

    _reattachAllListeners() {
        // Limpiar estado
        Object.values(this.friendListeners).forEach(fn => { try { fn(); } catch(e){} });
        Object.values(this.chatListeners).forEach(fn => { try { fn(); } catch(e){} });
        this.friendListeners = {};
        this.chatListeners = {};
        this._activeChallenges = {};
        this._globalPlayers = {};

        // Re-registrar
        this._listenGlobalRanking();
        this._listenIncomingChallenges();
        this._listenFriendsRealtime();
        this._listenGlobalChat();
        this._listenSemanasInfernales();

        // Re-abrir chat si estaba abierto
        if (this._currentChatId) {
            const path = this._currentChatId === '__global__'
                ? 'globalChat/messages'
                : `chats/${this._currentChatId}/messages`;
            this._attachChatListener(this._currentChatId, path);
        }

        console.log('[MP] Listeners re-registrados tras reconexión');
    },

    // Ping cada 4 min para mantener viva la conexión
    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveInterval = setInterval(() => {
            if (this._connected) {
                this.db.ref(`players/${this.myId}/lastSeen`)
                    .set(firebase.database.ServerValue.TIMESTAMP)
                    .catch(() => {});
            }
        }, 4 * 60 * 1000);
    },

    _stopKeepalive() {
        if (this._keepaliveInterval) { clearInterval(this._keepaliveInterval); this._keepaliveInterval = null; }
    },

    _startPresence() {
        this.db.ref(`players/${this.myId}/online`).set(true);
        this.db.ref(`players/${this.myId}/online`).onDisconnect().set(false);
        this.db.ref(`players/${this.myId}/lastSeen`).onDisconnect().set(firebase.database.ServerValue.TIMESTAMP);
    },

    _updateMyProfile() {
        if (!this.db || !this.myId) return;
        this.db.ref(`players/${this.myId}`).update({
            name: appState.userName,
            points: appState.totalPuntos,
            xp: appState.totalXP,
            level: appState.currentLevel,
            rank: appState.currentRank,
            banner: appState.equippedBanner || 'Estudiante',
            diabloWins: appState.diabloWins || 0,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
    },

    onSave() {
        this._updateMyProfile();
        this._checkChallengeProgress();
        this._syncSemanasInfernales();
    },

    // ════════════════════════════════════════════════════════════
    //  RANKING GLOBAL
    // ════════════════════════════════════════════════════════════
    _listenGlobalRanking() {
        const ref = this.db.ref('players').orderByChild('points').limitToLast(100);
        ref.on('value', snap => {
            this._globalPlayers = {};
            snap.forEach(child => {
                if (child.key !== this.myId) {
                    const d = child.val();
                    this._globalPlayers[child.key] = {
                        id: child.key, name: d.name || 'Jugador',
                        points: d.points || 0, rank: d.rank || 'Novato',
                        level: d.level || 1, online: d.online || false,
                        diabloWins: d.diabloWins || 0, isRealPlayer: true
                    };
                }
            });
            if (typeof renderRanking === 'function') renderRanking(getCurrentRankingFilter?.() || 'all');
        });
    },

    getGlobalPlayers() { return Object.values(this._globalPlayers); },

    // ════════════════════════════════════════════════════════════
    //  AMIGOS POR ID
    // ════════════════════════════════════════════════════════════
    async addFriendById(friendId) {
        friendId = friendId.trim().toUpperCase();
        if (!friendId.startsWith('HV-') || friendId.length < 5) {
            showCustomAlert('ID inválido. Formato: HV-XXXXXX', 'error'); return;
        }
        if (friendId === this.myId) { showCustomAlert('¡Ese es tu propio ID! 😄', 'warning'); return; }
        const snap = await this.db.ref(`players/${friendId}`).once('value');
        if (!snap.exists()) { showCustomAlert('Jugador no encontrado. ¿Ya se conectó alguna vez?', 'error'); return; }
        const data = snap.val();
        await this.db.ref(`friends/${this.myId}/${friendId}`).set(true);
        await this.db.ref(`friends/${friendId}/${this.myId}`).set(true);
        const fd = { id: friendId, name: data.name || 'Jugador', points: data.points || 0, rank: data.rank || 'Novato', isFriend: true, isRealPlayer: true };
        const idx = appState.friends.findIndex(f => f.id === friendId);
        if (idx >= 0) appState.friends[idx] = { ...appState.friends[idx], ...fd };
        else appState.friends.push(fd);
        SoundSystem.addFriend();
        showCustomAlert(`✅ ¡${data.name} agregado!`, 'success');
        saveState();
        this._listenFriendRealtime(friendId);
        renderFriendsList();
        renderRanking(getCurrentRankingFilter?.() || 'all');
    },

    _listenFriendsRealtime() {
        this.db.ref(`friends/${this.myId}`).once('value', snap => {
            if (snap.exists()) snap.forEach(c => this._listenFriendRealtime(c.key));
        });
        this.db.ref(`friends/${this.myId}`).on('child_added', snap => this._listenFriendRealtime(snap.key));
    },

    _listenFriendRealtime(friendId) {
        if (this.friendListeners[friendId]) return;
        const ref = this.db.ref(`players/${friendId}`);
        ref.on('value', snap => {
            if (!snap.exists()) return;
            const d = snap.val();
            const updated = { id: friendId, name: d.name||'Jugador', points: d.points||0, rank: d.rank||'Novato', level: d.level||1, online: d.online||false, diabloWins: d.diabloWins||0, isFriend: true, isRealPlayer: true };
            const idx = appState.friends.findIndex(f => f.id === friendId);
            if (idx >= 0) appState.friends[idx] = { ...appState.friends[idx], ...updated };
            else appState.friends.push(updated);
            saveState(); renderFriendsList(); renderRanking(getCurrentRankingFilter?.() || 'all');
        });
        this.friendListeners[friendId] = () => ref.off('value');
    },

    // ════════════════════════════════════════════════════════════
    //  DESAFÍOS NORMALES
    // ════════════════════════════════════════════════════════════
    async sendChallenge(friendId, type, durationHours) {
        const types = {
            study:  { label: 'Estudiar más minutos', field: 'totalHoras' },
            points: { label: 'Ganar más puntos',      field: 'totalPuntos' },
            xp:     { label: 'Ganar más XP',           field: 'totalXP' }
        };
        const t = types[type]; if (!t) return;
        await this.db.ref('challenges').push({
            from: this.myId, fromName: appState.userName, to: friendId,
            type, label: t.label, field: t.field, durationHours,
            startTime: firebase.database.ServerValue.TIMESTAMP,
            endTime: Date.now() + durationHours * 3600000,
            status: 'pending',
            fromBaseline: appState[t.field] || 0, toBaseline: 0,
            fromProgress: 0, toProgress: 0
        });
        showCustomAlert('⚔️ ¡Desafío enviado! Esperando respuesta...', 'success');
    },

    async acceptChallenge(challengeId) {
        const snap = await this.db.ref(`challenges/${challengeId}`).once('value');
        const c = snap.val();
        if (!c || c.status !== 'pending') return;
        await this.db.ref(`challenges/${challengeId}`).update({ status: 'active', toBaseline: appState[c.field] || 0, toProgress: 0 });
        showCustomAlert('⚔️ ¡Desafío aceptado!', 'success'); SoundSystem.win();
    },

    async rejectChallenge(challengeId) {
        await this.db.ref(`challenges/${challengeId}`).update({ status: 'rejected' });
        showCustomAlert('Desafío rechazado.', 'info');
    },

    _listenIncomingChallenges() {
        const handle = snap => {
            snap.forEach(c => { this._activeChallenges[c.key] = { id: c.key, ...c.val() }; });
            this._renderChallenges();
            this._checkPendingChallengeNotifs();
        };
        this.db.ref('challenges').orderByChild('to').equalTo(this.myId).on('value', handle);
        this.db.ref('challenges').orderByChild('from').equalTo(this.myId).on('value', handle);
    },

    _checkPendingChallengeNotifs() {
        Object.values(this._activeChallenges).forEach(c => {
            if (c.status === 'pending' && c.to === this.myId && !this._pendingNotifiedIds.has(c.id)) {
                this._pendingNotifiedIds.add(c.id);
                showCustomAlert(`⚔️ ¡${c.fromName} te desafía! "${c.label}" por ${c.durationHours}h`, 'info');
                const b = document.getElementById('challenge-badge'); if (b) b.style.display = 'inline-block';
            }
        });
    },

    _checkChallengeProgress() {
        Object.values(this._activeChallenges).forEach(c => {
            if (c.status !== 'active') return;
            const isFrom = c.from === this.myId, isTo = c.to === this.myId;
            if (!isFrom && !isTo) return;
            const baseline = isFrom ? c.fromBaseline : c.toBaseline;
            const progress = (appState[c.field] || 0) - baseline;
            this.db.ref(`challenges/${c.id}`).update({ [isFrom ? 'fromProgress' : 'toProgress']: progress });
            if (Date.now() > c.endTime) this.db.ref(`challenges/${c.id}`).update({ status: 'completed' });
        });
    },

    _renderChallenges() {
        const container = document.getElementById('challenges-container');
        if (!container) return;
        const badge = document.getElementById('challenge-badge');
        const list = Object.values(this._activeChallenges);
        if (list.length === 0) {
            container.innerHTML = '<p style="color:var(--secondary-text);text-align:center;padding:15px">No tienes desafíos activos. ¡Reta a un amigo!</p>';
            if (badge) badge.style.display = 'none'; return;
        }
        let pending = 0;
        container.innerHTML = list.map(c => {
            const isFrom = c.from === this.myId;
            const rivalName = isFrom ? (appState.friends.find(f => f.id === c.to)?.name || c.to) : c.fromName;
            const myProg = isFrom ? (c.fromProgress||0) : (c.toProgress||0);
            const rivProg = isFrom ? (c.toProgress||0) : (c.fromProgress||0);
            let timeLeft = '';
            if (c.endTime) {
                const ms = c.endTime - Date.now();
                if (ms > 0) { const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000); timeLeft = `⏱ ${h}h ${m}m`; }
                else timeLeft = '⏱ Terminado';
            }
            let body = '';
            if (c.status === 'pending' && c.to === this.myId) {
                pending++;
                body = `
                    <div class="challenge-rules-box">
                        <p>📋 <b>${c.label}</b> · ⏱ ${c.durationHours}h</p>
                        <p style="font-size:.8em;color:#888">El que más progreso acumule al final gana.</p>
                    </div>
                    <div class="challenge-actions">
                        <button onclick="MP.acceptChallenge('${c.id}')" class="btn-accept-challenge">✅ Aceptar</button>
                        <button onclick="MP.rejectChallenge('${c.id}')" class="btn-reject-challenge">❌ Rechazar</button>
                    </div>`;
            } else if (c.status === 'pending') {
                body = `<p class="challenge-waiting">⏳ Esperando a ${rivalName}...</p>`;
            } else if (c.status === 'active') {
                const max = Math.max(myProg, rivProg, 1);
                body = `<div class="challenge-progress">
                    <div class="cp-row"><span>Tú</span><div class="cp-bar"><div class="cp-fill mine" style="width:${Math.min(100,myProg/max*100)}%"></div></div><span>${myProg}</span></div>
                    <div class="cp-row"><span>${rivalName}</span><div class="cp-bar"><div class="cp-fill rival" style="width:${Math.min(100,rivProg/max*100)}%"></div></div><span>${rivProg}</span></div>
                </div>`;
            } else if (c.status === 'completed') {
                body = `<p class="challenge-result ${myProg>rivProg?'won':'lost'}">${myProg>rivProg?'🏆 ¡Ganaste!':'😔 Perdiste'} — Tú: ${myProg} vs ${rivalName}: ${rivProg}</p>
                <button class="btn-delete-challenge" onclick="MP.deleteChallenge('${c.id}')">🗑 Eliminar</button>`;
            } else {
                body = `<p class="challenge-result lost">❌ Rechazado</p>
                <button class="btn-delete-challenge" onclick="MP.deleteChallenge('${c.id}')">🗑 Eliminar</button>`;
            }
            return `<div class="challenge-card status-${c.status}">
                <div class="challenge-header">
                    <span class="challenge-type-icon">⚔️</span>
                    <div><h4>${c.label}</h4><small>Tú vs ${rivalName} · ${timeLeft}</small></div>
                    <span class="challenge-status-badge ${c.status}">${{pending:'⏳',active:'🔥',completed:'✅',rejected:'❌'}[c.status]||''} ${{pending:'Pendiente',active:'Activo',completed:'Terminado',rejected:'Rechazado'}[c.status]||c.status}</span>
                </div>${body}</div>`;
        }).join('');
        if (badge) badge.style.display = pending > 0 ? 'inline-block' : 'none';
    },

    openChallengeModal(friendId, friendName) {
        const modal = document.getElementById('challenge-modal');
        if (!modal) return;
        document.getElementById('challenge-modal-title').textContent = `⚔️ Desafiar a ${friendName}`;
        document.getElementById('challenge-friend-id').value = friendId;
        // Reset selects to defaults
        const typeSelect = document.getElementById('challenge-type');
        const hoursSelect = document.getElementById('challenge-hours');
        if (typeSelect) typeSelect.value = 'study';
        if (hoursSelect) hoursSelect.value = '24';
        modal.style.display = 'flex';
    },
    closeChallengeModal() {
        const modal = document.getElementById('challenge-modal');
        if (modal) modal.style.display = 'none';
    },
    async submitChallenge() {
        try {
            const fidEl   = document.getElementById('challenge-friend-id');
            const typeEl  = document.getElementById('challenge-type');
            const hoursEl = document.getElementById('challenge-hours');
            if (!fidEl || !typeEl || !hoursEl) {
                showCustomAlert('Error: elementos del formulario no encontrados.', 'error'); return;
            }
            const fid   = fidEl.value;
            const type  = typeEl.value;
            const hours = parseInt(hoursEl.value) || 24;
            if (!fid) { showCustomAlert('Error: ID de amigo no encontrado.', 'error'); return; }
            await this.sendChallenge(fid, type, hours);
            this.closeChallengeModal();
        } catch(e) {
            console.error('[MP] submitChallenge error:', e);
            showCustomAlert('Error al enviar el desafío. Verifica tu conexión.', 'error');
        }
    },

    async deleteChallenge(challengeId) {
        try {
            await this.db.ref(`challenges/${challengeId}`).remove();
            delete this._activeChallenges[challengeId];
            this._renderChallenges();
        } catch(e) {
            console.error('[MP] deleteChallenge error:', e);
        }
    },

    // ════════════════════════════════════════════════════════════
    //  CHAT (con reconexión automática)
    // ════════════════════════════════════════════════════════════
    openChat(friendId, friendName) {
        const chatId = [this.myId, friendId].sort().join('_');
        this._currentChatId = chatId;
        document.getElementById('chat-title').textContent = `💬 Chat con ${friendName}`;
        document.getElementById('chat-modal').style.display = 'flex';
        this._attachChatListener(chatId, `chats/${chatId}/messages`);
    },

    openGlobalChat() {
        this._currentChatId = '__global__';
        document.getElementById('chat-title').textContent = '🌍 Chat Global';
        document.getElementById('chat-modal').style.display = 'flex';
        const b = document.getElementById('global-chat-badge'); if (b) b.style.display = 'none';
        this._attachChatListener('__global__', 'globalChat/messages');
    },

    _attachChatListener(chatId, path) {
        if (this.chatListeners[chatId]) { try { this.chatListeners[chatId](); } catch(e){} }
        const ref = this.db.ref(path).limitToLast(60);
        ref.on('value', snap => {
            const msgs = []; snap.forEach(c => msgs.push(c.val()));
            this._renderChatMessages(msgs);
        }, err => {
            console.warn('[MP] Chat error, reintentando en 2s...', err);
            setTimeout(() => this._attachChatListener(chatId, path), 2000);
        });
        this.chatListeners[chatId] = () => ref.off('value');
    },

    closeChat() { document.getElementById('chat-modal').style.display = 'none'; this._currentChatId = null; },

    sendChatMessage(text) {
        if (!text.trim() || !this._currentChatId) return;
        const path = this._currentChatId === '__global__' ? 'globalChat/messages' : `chats/${this._currentChatId}/messages`;
        this.db.ref(path).push({ senderId: this.myId, senderName: appState.userName, text: text.trim(), timestamp: firebase.database.ServerValue.TIMESTAMP });
    },

    _renderChatMessages(msgs) {
        const c = document.getElementById('chat-messages'); if (!c) return;
        c.innerHTML = msgs.map(m => {
            const me = m.senderId === this.myId;
            const t  = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'}) : '';
            return `<div class="chat-msg ${me?'mine':'theirs'}">${!me?`<span class="chat-sender">${m.senderName}</span>`:''}<div class="chat-bubble">${m.text}</div><span class="chat-time">${t}</span></div>`;
        }).join('');
        c.scrollTop = c.scrollHeight;
    },

    _listenGlobalChat() {
        this.db.ref('globalChat/messages').limitToLast(1).on('child_added', snap => {
            const msg = snap.val();
            if (msg && msg.senderId !== this.myId && this._currentChatId !== '__global__') {
                const b = document.getElementById('global-chat-badge'); if (b) b.style.display = 'inline-block';
            }
        });
    },

    // ════════════════════════════════════════════════════════════
    //  🔴 SEMANA INFERNAL
    // ════════════════════════════════════════════════════════════
    openHellWeekModal() {
        document.getElementById('hell-week-modal').style.display = 'flex';
        const list = document.getElementById('hell-participants-list');
        list.innerHTML = '';
        const realFriends = appState.friends.filter(f => f.isRealPlayer);
        if (realFriends.length === 0) {
            list.innerHTML = '<p style="color:#888;font-size:.85em">Primero conecta amigos por ID para invitarlos.</p>';
            return;
        }
        realFriends.forEach(f => {
            const div = document.createElement('div');
            div.className = 'hell-participant-option';
            div.innerHTML = `<label><input type="checkbox" class="hell-participant-cb" value="${f.id}" data-name="${f.name}"> ${f.name} <span style="color:#888;font-size:.8em">(${f.id})</span></label>`;
            list.appendChild(div);
        });
    },

    closeHellWeekModal() { document.getElementById('hell-week-modal').style.display = 'none'; },

    async createHellWeek() {
        const selected = [...document.querySelectorAll('.hell-participant-cb:checked')];
        if (selected.length === 0) { showCustomAlert('Selecciona al menos un amigo.', 'error'); return; }

        const participants = [this.myId, ...selected.map(cb => cb.value)];
        const participantNames = { [this.myId]: appState.userName };
        selected.forEach(cb => { participantNames[cb.value] = cb.dataset.name; });

        const start = new Date(); start.setHours(0,0,0,0);
        const end   = new Date(start); end.setDate(end.getDate() + 7);

        const hw = {
            createdBy: this.myId, participants, participantNames,
            startTime: start.getTime(), endTime: end.getTime(),
            status: 'pending', acceptedBy: { [this.myId]: true },
            dailyData: {}, totalMinutes: {}, baseline: {}
        };
        participants.forEach(id => { hw.totalMinutes[id] = 0; hw.dailyData[id] = {}; hw.baseline[id] = 0; });
        hw.baseline[this.myId] = appState.totalHoras || 0;

        const ref = await this.db.ref('semanasInfernales').push(hw);
        const hellId = ref.key;

        for (const pid of participants.filter(p => p !== this.myId)) {
            await this.db.ref(`hellInvites/${pid}/${hellId}`).set({ from: this.myId, fromName: appState.userName, hellId, participantNames });
        }

        showCustomAlert('🔴 ¡Semana Infernal creada! Esperando aceptaciones.', 'success');
        SoundSystem.jackpot();
        this.closeHellWeekModal();
    },

    _listenSemanasInfernales() {
        // Invitaciones entrantes
        this.db.ref(`hellInvites/${this.myId}`).on('child_added', snap => {
            const inv = snap.val(); if (!inv) return;
            showCustomAlert(`🔴 ¡${inv.fromName} te invita a una Semana Infernal!`, 'info');
            const b = document.getElementById('challenge-badge'); if (b) b.style.display = 'inline-block';
            this._renderHellInvites();
        });

        // Semanas donde participo
        this.db.ref('semanasInfernales').on('value', snap => {
            this._semanasInfernales = {};
            snap.forEach(child => {
                const d = child.val();
                if (d.participants && d.participants.includes(this.myId)) {
                    this._semanasInfernales[child.key] = { id: child.key, ...d };
                }
            });
            this._updateMyActiveHell();
            this._renderHellWeeks();
            this._applyHellWeekEffects();
            this._checkDailyHellObligations();
        });
    },

    _updateMyActiveHell() {
        const now = Date.now();
        this._myActiveHell = Object.values(this._semanasInfernales)
            .find(hw => hw.status === 'active' && hw.startTime <= now && hw.endTime > now) || null;
    },

    async acceptHellInvite(hellId) {
        await this.db.ref(`semanasInfernales/${hellId}/acceptedBy/${this.myId}`).set(true);
        await this.db.ref(`semanasInfernales/${hellId}/baseline/${this.myId}`).set(appState.totalHoras || 0);

        // Comprobar si todos aceptaron
        const snap = await this.db.ref(`semanasInfernales/${hellId}`).once('value');
        const hw = snap.val();
        const allOk = hw.participants.every(p => p === hw.createdBy || hw.acceptedBy?.[p]);
        if (allOk) await this.db.ref(`semanasInfernales/${hellId}/status`).set('active');

        await this.db.ref(`hellInvites/${this.myId}/${hellId}`).remove();
        showCustomAlert('🔴 ¡Semana Infernal aceptada! Prepárate...', 'success');
        SoundSystem.jackpot();
    },

    async rejectHellInvite(hellId) {
        await this.db.ref(`hellInvites/${this.myId}/${hellId}`).remove();
        showCustomAlert('Invitación rechazada.', 'info');
        this._renderHellInvites();
    },

    // ── Check-in diario ────────────────────────────────────────
    async hellCheckIn() {
        if (!this._myActiveHell) return;
        const hw = this._myActiveHell;
        const today = this._getHellDay(hw);
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes();
        const onTime = h < 7 || (h === 7 && m === 0);

        await this.db.ref(`semanasInfernales/${hw.id}/dailyData/${this.myId}/day${today}`).update({
            checkin: true,
            checkinTime: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
            checkinOnTime: onTime,
            dayStartMinutes: appState.totalHoras || 0
        });

        if (onTime) showCustomAlert('✅ ¡Check-in realizado a tiempo! Recompensas ×2 activadas.', 'success');
        else {
            this._applyHellPenalty('checkin_late');
            showCustomAlert('⏰ Check-in tardío — penalización aplicada: -500pts, -10🥇, -1💎', 'warning');
        }
        this._renderHellWeeks();
    },

    _lastPenaltyDay: null,
    _checkDailyHellObligations() {
        if (!this._myActiveHell) return;
        const hw = this._myActiveHell;
        const today = this._getHellDay(hw);
        if (today <= 1) return;
        const yesterday = today - 1;
        const penaltyKey = `hellPenalty_${hw.id}_day${yesterday}`;
        if (localStorage.getItem(penaltyKey)) return; // ya aplicado
        localStorage.setItem(penaltyKey, '1');

        const dayData = hw.dailyData?.[this.myId]?.[`day${yesterday}`] || {};
        const msgs = [];
        if (!dayData.checkin)        { this._applyHellPenalty('no_checkin');  msgs.push('check-in'); }
        if (!dayData.studyCompleted) { this._applyHellPenalty('no_study');    msgs.push('8h estudio'); }
        if (!dayData.exercised)      { this._applyHellPenalty('no_exercise'); msgs.push('ejercicio'); }
        if (msgs.length > 0) showCustomAlert(`🔴 Penalizaciones por ayer (${msgs.join(', ')}): -500pts, -10🥇, -1💎 por cada una`, 'error');
    },

    _applyHellPenalty(reason) {
        appState.totalPuntos = Math.max(0, (appState.totalPuntos||0) - 500);
        appState.lingotes    = Math.max(0, (appState.lingotes||0) - 10);
        appState.gemas       = Math.max(0, (appState.gemas||0) - 1);
        saveState();
    },

    markHellExercise() {
        if (!this._myActiveHell) return;
        const hw = this._myActiveHell;
        const today = this._getHellDay(hw);
        this.db.ref(`semanasInfernales/${hw.id}/dailyData/${this.myId}/day${today}`).update({ exercised: true });
    },

    _syncSemanasInfernales() {
        if (!this._myActiveHell) return;
        const hw = this._myActiveHell;
        const today = this._getHellDay(hw);
        if (today < 1 || today > 7) return;
        const dayKey = `day${today}`;
        const dayStart = hw.dailyData?.[this.myId]?.[dayKey]?.dayStartMinutes ?? (appState.totalHoras || 0);
        const todayMins = Math.max(0, (appState.totalHoras||0) - dayStart);
        const baseline  = hw.baseline?.[this.myId] || 0;
        const totalProg = Math.max(0, (appState.totalHoras||0) - baseline);
        this.db.ref(`semanasInfernales/${hw.id}/dailyData/${this.myId}/${dayKey}`).update({
            studyMinutes: todayMins, studyCompleted: todayMins >= 480
        });
        this.db.ref(`semanasInfernales/${hw.id}/totalMinutes/${this.myId}`).set(totalProg);
    },

    _applyHellWeekEffects() {
        const body = document.body;
        if (this._myActiveHell) {
            body.classList.add('hell-week-active');
            // Bloquear casino
            document.querySelectorAll('.casino-section, #casino, [data-target="casino"]').forEach(el => el.classList.add('hell-casino-locked'));
        } else {
            body.classList.remove('hell-week-active');
            document.querySelectorAll('.hell-casino-locked').forEach(el => el.classList.remove('hell-casino-locked'));
        }
    },

    isHellWeekActive() { return !!this._myActiveHell; },
    getHellWeekMultiplier() { return this._myActiveHell ? 2 : 1; },

    async _checkHellWeekEnd() {
        for (const [hwId, hw] of Object.entries(this._semanasInfernales)) {
            if (hw.status !== 'active' || Date.now() <= hw.endTime) continue;
            const mins = hw.totalMinutes || {};
            let winner = null, maxM = -1;
            Object.entries(mins).forEach(([pid, m]) => { if (m > maxM) { maxM = m; winner = pid; } });
            await this.db.ref(`semanasInfernales/${hwId}`).update({ status: 'completed', winner });

            if (winner === this.myId) {
                appState.diabloWins = (appState.diabloWins || 0) + 1;
                if (!appState.banners.includes('😈 Diablo')) appState.banners.push('😈 Diablo');
                appState.equippedBanner = '😈 Diablo';
                saveState(); SoundSystem.jackpot();
                showCustomAlert(`🏆 ¡GANASTE LA SEMANA INFERNAL! Banner 😈 Diablo desbloqueado. Victoria #${appState.diabloWins}`, 'special');
            } else {
                const wname = hw.participantNames?.[winner] || winner;
                showCustomAlert(`🔴 Semana terminada. Ganador: ${wname} con ${Math.floor(maxM/60)}h ${maxM%60}m`, 'info');
            }
        }
    },

    _renderHellInvites() {
        this.db.ref(`hellInvites/${this.myId}`).once('value', snap => {
            const c = document.getElementById('hell-invites-container'); if (!c) return;
            if (!snap.exists()) { c.innerHTML = ''; return; }
            let html = '';
            snap.forEach(child => {
                const inv = child.val();
                const names = Object.values(inv.participantNames||{}).join(', ');
                html += `<div class="hell-invite-card">
                    <div class="hell-invite-header"><span class="hell-icon">🔴</span>
                        <div><h4>Invitación — Semana Infernal</h4><small>De: ${inv.fromName} · Grupo: ${names}</small></div>
                    </div>
                    <div class="hell-invite-rules">
                        <p><b>📋 Reglas:</b></p>
                        <ul>
                            <li>✅ Check-in antes de las 7:00 AM (sino: -500pts -10🥇 -1💎)</li>
                            <li>📚 Mínimo 8 horas de estudio diarias (misma penalización)</li>
                            <li>💪 Al menos 1 ejercicio diario (misma penalización)</li>
                            <li>🎰 Casino desactivado toda la semana</li>
                            <li>⭐ Todas las recompensas ×2</li>
                            <li>🏆 El que más horas estudie gana el banner 😈 Diablo + contador de victorias</li>
                        </ul>
                    </div>
                    <div class="challenge-actions">
                        <button onclick="MP.acceptHellInvite('${child.key}')" class="btn-accept-challenge">🔥 ¡Aceptar!</button>
                        <button onclick="MP.rejectHellInvite('${child.key}')" class="btn-reject-challenge">❌ Rechazar</button>
                    </div>
                </div>`;
            });
            c.innerHTML = html;
        });
    },

    _renderHellWeeks() {
        const container = document.getElementById('hell-weeks-container'); if (!container) return;
        const weeks = Object.values(this._semanasInfernales);

        // Render invites first
        this._renderHellInvites();

        if (weeks.length === 0) {
            container.innerHTML = '<p style="color:var(--secondary-text);text-align:center;padding:10px">No hay semanas infernales activas.</p>';
            return;
        }
        container.innerHTML = weeks.map(hw => {
            const now = Date.now();
            const today = this._getHellDay(hw);
            const daysLeft = Math.max(0, Math.ceil((hw.endTime - now) / 86400000));
            const statusLabel = {pending:'⏳ Pendiente',active:'🔴 ACTIVA',completed:'✅ Terminada'}[hw.status]||hw.status;

            // Tabla de participantes
            const rows = (hw.participants||[]).map(pid => {
                const name = hw.participantNames?.[pid] || pid;
                const totalM = hw.totalMinutes?.[pid] || 0;
                const dd = hw.dailyData?.[pid]?.[`day${today}`] || {};
                const isMe = pid === this.myId;

                // ¿Ganó el día anterior?
                let dayBadge = '';
                if (today > 1 && (hw.participants||[]).length > 1) {
                    const prev = today - 1;
                    const allPrev = (hw.participants||[]).map(p => ({ p, m: hw.dailyData?.[p]?.[`day${prev}`]?.studyMinutes||0 })).sort((a,b)=>b.m-a.m);
                    if (allPrev[0].p === pid && allPrev[0].m > 0 && allPrev[0].m > (allPrev[1]?.m||0)) dayBadge = ' 🏅';
                }

                // Contador victorias Diablo
                const diabloStr = (hw.winner === pid && hw.status === 'completed') ? ' 😈' : '';

                return `<tr class="${isMe?'hell-me-row':''}">
                    <td>${isMe?'<b>':''}${name}${dayBadge}${diabloStr}${isMe?'</b>':''}</td>
                    <td>${Math.floor(totalM/60)}h ${totalM%60}m</td>
                    <td>${dd.checkin ? (dd.checkinOnTime?'✅':'⏰') : (today>=1?'❌':'–')}</td>
                    <td>${dd.studyCompleted?'✅':(dd.studyMinutes?`${Math.floor(dd.studyMinutes/60)}h ${dd.studyMinutes%60}m`:'–')}</td>
                    <td>${dd.exercised?'✅':'–'}</td>
                </tr>`;
            }).join('');

            const myDayData = hw.dailyData?.[this.myId]?.[`day${today}`] || {};
            const canCheckin = hw.status==='active' && today>=1 && !myDayData.checkin;
            const winnerBlock = hw.status==='completed'
                ? `<div class="hell-winner-block">🏆 Ganador: <b>${hw.participantNames?.[hw.winner]||hw.winner}</b> — ${Math.floor((hw.totalMinutes?.[hw.winner]||0)/60)}h ${(hw.totalMinutes?.[hw.winner]||0)%60}m</div>`
                : '';

            // Ganador del día actual
            let dayLeaderBlock = '';
            if (hw.status==='active' && today>1) {
                const prev = today-1;
                const winner = this.getHellDayWinner(prev);
                if (winner) {
                    const msg = winner.id === this.myId
                        ? `🏅 ¡Ganaste el día ${prev}! Faltan ${7-prev} días.`
                        : `🏅 ${winner.name} ganó el día ${prev} con ${Math.floor(winner.minutes/60)}h. Faltan ${7-prev} días.`;
                    dayLeaderBlock = `<div class="hell-day-leader">${msg}</div>`;
                }
            }

            return `<div class="hell-week-card ${hw.status==='active'?'hell-active':''}">
                <div class="hell-week-header">
                    <span class="hell-big-icon">🔴</span>
                    <div><h4>Semana Infernal ${statusLabel}</h4>
                    <small>Día ${today}/7 · ${daysLeft} días restantes · ${(hw.participants||[]).length} participantes</small></div>
                </div>
                ${winnerBlock}
                ${dayLeaderBlock}
                ${canCheckin?`<button class="btn-hell-checkin" onclick="MP.hellCheckIn()">✅ Check-in Día ${today} (antes 7:00 AM)</button>`:''}
                <div class="hell-table-wrap">
                    <table class="hell-progress-table">
                        <thead><tr><th>Jugador</th><th>Total</th><th>Check-in</th><th>8h Estudio</th><th>Ejercicio</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>`;
        }).join('');

        this._checkHellWeekEnd();
    },

    _getHellDay(hw) {
        const now = Date.now();
        if (now < hw.startTime) return 0;
        return Math.min(7, Math.floor((now - hw.startTime) / 86400000) + 1);
    },

    getHellDayWinner(dayNumber) {
        if (!this._myActiveHell) return null;
        const hw = this._myActiveHell;
        let winner = null, maxM = -1;
        (hw.participants||[]).forEach(pid => {
            const m = hw.dailyData?.[pid]?.[`day${dayNumber}`]?.studyMinutes || 0;
            if (m > maxM) { maxM = m; winner = pid; }
        });
        return winner && maxM > 0 ? { id: winner, name: hw.participantNames?.[winner]||winner, minutes: maxM } : null;
    }
};
