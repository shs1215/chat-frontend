import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { useTranslation } from 'react-i18next';

const API_URL = 'https://chat-backend-gukk.onrender.com/api/auth';
const ROOM_URL = 'https://chat-backend-gukk.onrender.com/api/rooms';
const SOCKET_URL = 'https://chat-backend-gukk.onrender.com';

const STORAGE = {
  user: 'chat_user',
  token: 'chat_token',
  lang: 'chat_lang',
  activeItem: 'chat_active_item',
  chatList: 'chat_chat_list',
  roomList: 'chat_room_list',
  sidebarWidth: 'chat_sidebar_width',
};

const EMOJIS = ['👍', '❤️', '🔥', '😂', '😮'];

const safeJsonParse = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const getId = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.id || value._id || value.toString?.() || '';
};

const sameId = (a, b) => getId(a) === getId(b);

const normalizeText = (value = '') => String(value).trim().toLowerCase();

const normalizeUser = (user) => {
  if (!user) return null;
  const id = getId(user);
  return {
    id,
    _id: id,
    nickname: user.nickname || '',
    email: user.email || '',
  };
};

const normalizeRoom = (room) => {
  if (!room) return null;
  const id = getId(room);
  return {
    id,
    _id: id,
    name: room.name || '',
    username: room.username || '',
    description: room.description || '',
    topic: room.topic || '',
    type: room.type || 'group',
    owner: room.owner || '',
    members: Array.isArray(room.members) ? room.members : [],
    inviteCode: room.inviteCode || '',
    avatar: room.avatar || '',
    pinnedMessages: Array.isArray(room.pinnedMessages) ? room.pinnedMessages : [],
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
};

const normalizeMessage = (message) => {
  if (!message) return null;

  return {
    id: getId(message),
    _id: getId(message),
    sender:
      message.sender && typeof message.sender === 'object'
        ? normalizeUser(message.sender)
        : getId(message.sender),
    receiver:
      message.receiver && typeof message.receiver === 'object'
        ? normalizeUser(message.receiver)
        : message.receiver
          ? getId(message.receiver)
          : null,
    room:
      message.room && typeof message.room === 'object'
        ? normalizeRoom(message.room)
        : message.room
          ? getId(message.room)
          : null,
    messageText: message.messageText || '',
    mediaUrl: message.mediaUrl || '',
    mediaType: message.mediaType || '',
    mediaName: message.mediaName || '',
    replyTo: message.replyTo
      ? {
          id: getId(message.replyTo),
          messageText: message.replyTo.messageText || '',
          mediaUrl: message.replyTo.mediaUrl || '',
          mediaType: message.replyTo.mediaType || '',
          mediaName: message.replyTo.mediaName || '',
          sender:
            message.replyTo.sender && typeof message.replyTo.sender === 'object'
              ? normalizeUser(message.replyTo.sender)
              : getId(message.replyTo.sender),
          createdAt: message.replyTo.createdAt || null,
        }
      : null,
    forwardedFrom: message.forwardedFrom
      ? {
          id: getId(message.forwardedFrom),
          messageText: message.forwardedFrom.messageText || '',
          mediaUrl: message.forwardedFrom.mediaUrl || '',
          mediaType: message.forwardedFrom.mediaType || '',
          mediaName: message.forwardedFrom.mediaName || '',
          sender:
            message.forwardedFrom.sender && typeof message.forwardedFrom.sender === 'object'
              ? normalizeUser(message.forwardedFrom.sender)
              : getId(message.forwardedFrom.sender),
          createdAt: message.forwardedFrom.createdAt || null,
        }
      : null,
    deletedForAll: !!message.deletedForAll,
    reactions: Array.isArray(message.reactions)
      ? message.reactions.map((r) => ({
          user: getId(r.user),
          emoji: r.emoji,
        }))
      : [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
};

const dedupeById = (items) => {
  const map = new Map();
  items.filter(Boolean).forEach((item) => {
    const id = getId(item);
    if (id) map.set(id, item);
  });
  return Array.from(map.values());
};

const addToTopUnique = (item, list) => {
  const filtered = list.filter((x) => getId(x) !== getId(item));
  return dedupeById([item, ...filtered]);
};

const upsertUnique = (item, list) => {
  const filtered = list.filter((x) => getId(x) !== getId(item));
  return dedupeById([item, ...filtered]);
};

const addOrReplaceMessage = (list, message) => {
  const id = getId(message);
  if (!id) return [...list, message];
  const exists = list.some((m) => getId(m) === id);
  if (exists) {
    return list.map((m) => (getId(m) === id ? message : m));
  }
  return [...list, message];
};

const getRoomOwnerId = (room) => {
  if (!room) return '';
  if (typeof room.owner === 'string') return room.owner;
  return room.owner?.id || room.owner?._id || '';
};

const getRoomMemberEntry = (room, userId) => {
  const members = room?.members || [];
  return members.find((m) => sameId(m?.user, userId));
};

const getRoomRole = (room, userId) => {
  if (!room) return null;
  if (sameId(getRoomOwnerId(room), userId)) return 'owner';
  return getRoomMemberEntry(room, userId)?.role || null;
};

const canWriteRoom = (room, userId) => {
  if (!room) return false;
  if (room.type === 'group') return !!getRoomMemberEntry(room, userId) || sameId(getRoomOwnerId(room), userId);
  const role = getRoomRole(room, userId);
  return role === 'owner' || role === 'admin';
};

function App() {
  const { t, i18n } = useTranslation();

  const [isLogin, setIsLogin] = useState(true);
  const [isForgot, setIsForgot] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [showRoomInfo, setShowRoomInfo] = useState(false);

  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem(STORAGE.token) || '');

  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const [newNickname, setNewNickname] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [deletePassword, setDeletePassword] = useState('');

  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomType, setNewRoomType] = useState('group');
  const [newRoomTopic, setNewRoomTopic] = useState('');
  const [newRoomUsername, setNewRoomUsername] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');

  const [chatList, setChatList] = useState([]);
  const [roomList, setRoomList] = useState([]);
  const [searchNickname, setSearchNickname] = useState('');
  const [searchRoomUsername, setSearchRoomUsername] = useState('');
  const [joinInviteCode, setJoinInviteCode] = useState('');

  const [activeItem, setActiveItem] = useState(null);
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState([]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(STORAGE.sidebarWidth));
    return Number.isFinite(saved) && saved >= 220 ? saved : 300;
  });

  const [roomDetails, setRoomDetails] = useState(null);
  const [roomEditName, setRoomEditName] = useState('');
  const [roomEditUsername, setRoomEditUsername] = useState('');
  const [roomEditDescription, setRoomEditDescription] = useState('');
  const [roomEditTopic, setRoomEditTopic] = useState('');
  const [memberNickname, setMemberNickname] = useState('');
  const [memberSearchResult, setMemberSearchResult] = useState(null);
  const [replyToMessage, setReplyToMessage] = useState(null);
  const [forwardMessage, setForwardMessage] = useState(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const [selectedMedia, setSelectedMedia] = useState(null);
  const [mediaInputKey, setMediaInputKey] = useState(0);

  const socketRef = useRef(null);
  const isResizing = useRef(false);
  const messagesEndRef = useRef(null);
  const userRef = useRef(null);
  const activeItemRef = useRef(null);
  const messageRefs = useRef({});
  const pendingInviteCodeRef = useRef('');

  const normalizeStoredActiveItem = (item) => {
    if (!item) return null;
    return {
      type: item.type,
      id: getId(item.id),
      label: item.label || '',
      roomType: item.roomType || '',
      creator: item.creator || '',
    };
  };

  const clearSession = () => {
    localStorage.removeItem(STORAGE.user);
    localStorage.removeItem(STORAGE.token);
    localStorage.removeItem(STORAGE.activeItem);
    localStorage.removeItem(STORAGE.chatList);
    localStorage.removeItem(STORAGE.roomList);
  };

  const removeRoomFromLocalState = (roomId) => {
    setRoomList((prev) => prev.filter((room) => !sameId(room.id, roomId)));
    if (sameId(activeItemRef.current?.id, roomId)) {
      setActiveItem(null);
      setMessages([]);
      setRoomDetails(null);
      setShowRoomInfo(false);
    }
  };

  const loadRoomDetails = async (roomId) => {
    try {
      const res = await axios.get(`${ROOM_URL}/details/${roomId}`);
      const room = normalizeRoom(res.data);
      setRoomDetails(room);
      setRoomEditName(room.name || '');
      setRoomEditUsername(room.username || '');
      setRoomEditDescription(room.description || '');
      setRoomEditTopic(room.topic || '');
      return room;
    } catch (err) {
      setRoomDetails(null);
      if (err.response?.status === 404) {
        removeRoomFromLocalState(roomId);
      }
      return null;
    }
  };

  const fetchChatList = async (userId) => {
    try {
      const res = await axios.get(`${API_URL}/chats/${userId}`);
      const fetched = Array.isArray(res.data) ? res.data.map(normalizeUser).filter(Boolean) : [];
      setChatList((prev) => dedupeById([...fetched, ...prev]));
    } catch {
      const cached = safeJsonParse(localStorage.getItem(STORAGE.chatList), []);
      setChatList(Array.isArray(cached) ? cached.map(normalizeUser).filter(Boolean) : []);
    }
  };

  const fetchRoomsList = async (userId) => {
    try {
      const res = await axios.get(`${ROOM_URL}/user-rooms/${userId}`);
      const fetched = Array.isArray(res.data) ? res.data.map(normalizeRoom).filter(Boolean) : [];
      setRoomList((prev) => dedupeById([...fetched, ...prev]));
    } catch {
      const cached = safeJsonParse(localStorage.getItem(STORAGE.roomList), []);
      setRoomList(Array.isArray(cached) ? cached.map(normalizeRoom).filter(Boolean) : []);
    }
  };

  const joinByInviteCode = async (inviteCode, currentUserId) => {
    const code = String(inviteCode || '').trim();
    const uid = currentUserId || userRef.current?.id;
    if (!code || !uid) return;

    const res = await axios.post(`${ROOM_URL}/join/${code}`, { userId: uid });
    const room = normalizeRoom(res.data.room);
    setRoomList((prev) => upsertUnique(room, prev));
    setActiveItem({
      type: 'room',
      id: room.id,
      label: room.name,
      roomType: room.type,
      creator: room.owner,
    });
    setShowRoomInfo(false);
    await loadRoomDetails(room.id);
  };

  const connectSocket = (userId) => {
    if (!userId) return null;

    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    const register = () => {
      socket.emit('register_user', userId);
    };

    socket.on('connect', register);
    register();

    socket.on('receive_message', (raw) => {
      const msg = normalizeMessage(raw);
      const currentUserId = userRef.current?.id || '';
      const currentActive = activeItemRef.current;

      if (!msg) return;

      if (msg.room) {
        if (currentActive?.type === 'room' && sameId(msg.room, currentActive.id)) {
          setMessages((prev) => addOrReplaceMessage(prev, msg));
        }
        return;
      }

      const senderId = getId(msg.sender);
      const receiverId = getId(msg.receiver);

      if (
        currentActive?.type === 'user' &&
        (sameId(senderId, currentActive.id) || sameId(receiverId, currentActive.id))
      ) {
        setMessages((prev) => addOrReplaceMessage(prev, msg));
      }

      const otherSide = sameId(senderId, currentUserId) ? msg.receiver : msg.sender;
      if (otherSide && typeof otherSide === 'object') {
        const normalizedOther = normalizeUser(otherSide);
        if (normalizedOther?.id && !sameId(normalizedOther.id, currentUserId)) {
          setChatList((prev) => addToTopUnique(normalizedOther, prev));
        }
      }
    });

    socket.on('message_updated', (raw) => {
      const msg = normalizeMessage(raw);
      if (!msg) return;
      setMessages((prev) => prev.map((m) => (getId(m) === getId(msg) ? msg : m)));
    });

    return socket;
  };

  const bootstrapSession = async (sessionUser, sessionToken) => {
    const normalizedUser = normalizeUser(sessionUser);
    userRef.current = normalizedUser;
    setUser(normalizedUser);
    setToken(sessionToken);
    setNewNickname(normalizedUser.nickname || '');
    setNewEmail(normalizedUser.email || '');
    setNewPassword('');

    await Promise.all([
      fetchChatList(normalizedUser.id),
      fetchRoomsList(normalizedUser.id),
    ]);

    connectSocket(normalizedUser.id);

    if (pendingInviteCodeRef.current) {
      const code = pendingInviteCodeRef.current;
      pendingInviteCodeRef.current = '';
      try {
        await joinByInviteCode(code, normalizedUser.id);
      } catch {
        // ignore auto-join failures
      }
    }
  };

  useEffect(() => {
    const savedLang = localStorage.getItem(STORAGE.lang);
    if (savedLang) {
      i18n.changeLanguage(savedLang);
    }
  }, [i18n]);

  useEffect(() => {
    const savedUser = safeJsonParse(localStorage.getItem(STORAGE.user), null);
    const savedToken = localStorage.getItem(STORAGE.token);
    const savedActiveItem = normalizeStoredActiveItem(safeJsonParse(localStorage.getItem(STORAGE.activeItem), null));
    const cachedChats = safeJsonParse(localStorage.getItem(STORAGE.chatList), []);
    const cachedRooms = safeJsonParse(localStorage.getItem(STORAGE.roomList), []);

    if (Array.isArray(cachedChats) && cachedChats.length) {
      setChatList(cachedChats.map(normalizeUser).filter(Boolean));
    }
    if (Array.isArray(cachedRooms) && cachedRooms.length) {
      setRoomList(cachedRooms.map(normalizeRoom).filter(Boolean));
    }

    const params = new URLSearchParams(window.location.search);
    const inviteFromQuery = params.get('invite');
    const inviteFromPath = window.location.pathname.match(/\/join\/([^/]+)/)?.[1];
    const inviteCode = inviteFromQuery || inviteFromPath;

    if (inviteCode) {
      pendingInviteCodeRef.current = inviteCode;
    }

    if (savedUser && savedToken) {
      const normalizedUser = normalizeUser(savedUser);
      setUser(normalizedUser);
      setToken(savedToken);
      setNewNickname(normalizedUser.nickname || '');
      setNewEmail(normalizedUser.email || '');
      userRef.current = normalizedUser;

      if (savedActiveItem) {
        setActiveItem(savedActiveItem);
      }

      bootstrapSession(normalizedUser, savedToken);
    }
  }, []);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    activeItemRef.current = activeItem;
    if (activeItem) {
      localStorage.setItem(STORAGE.activeItem, JSON.stringify(activeItem));
    } else {
      localStorage.removeItem(STORAGE.activeItem);
    }
  }, [activeItem]);

  useEffect(() => {
    localStorage.setItem(STORAGE.sidebarWidth, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem(STORAGE.chatList, JSON.stringify(chatList));
  }, [chatList]);

  useEffect(() => {
    localStorage.setItem(STORAGE.roomList, JSON.stringify(roomList));
  }, [roomList]);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing.current) return;
      if (e.clientX >= 220 && e.clientX <= 520) {
        setSidebarWidth(e.clientX);
      }
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = 'default';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!activeItem || !user) {
      setRoomDetails(null);
      return;
    }

    const loadMessages = async () => {
      try {
        if (activeItem.type === 'user') {
          const res = await axios.get(`${API_URL}/messages/${user.id}/${activeItem.id}`);
          setMessages(Array.isArray(res.data) ? res.data.map(normalizeMessage) : []);
        } else if (activeItem.type === 'room') {
          if (socketRef.current) {
            socketRef.current.emit('join_room', activeItem.id);
          }
          const res = await axios.get(`${ROOM_URL}/messages/${activeItem.id}`);
          setMessages(Array.isArray(res.data) ? res.data.map(normalizeMessage) : []);
          await loadRoomDetails(activeItem.id);
        }
      } catch {
        setMessages([]);
      }
    };

    loadMessages();

    return () => {
      if (socketRef.current && activeItem.type === 'room') {
        socketRef.current.emit('leave_room', activeItem.id);
      }
    };
  }, [activeItem, user]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activeItem]);

  useEffect(() => {
    if (!user?.id) return;
    const timer = setInterval(() => {
      fetchRoomsList(user.id);
    }, 15000);
    return () => clearInterval(timer);
  }, [user?.id]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setErrorMessage('');

    try {
      if (isLogin) {
        const res = await axios.post(`${API_URL}/login`, { nickname, password });
        const sessionUser = res.data.user;
        const sessionToken = res.data.token;

        localStorage.setItem(STORAGE.user, JSON.stringify(sessionUser));
        localStorage.setItem(STORAGE.token, sessionToken);

        setNickname('');
        setPassword('');
        setIsForgot(false);
        setShowSettings(false);

        await bootstrapSession(sessionUser, sessionToken);
      } else {
        await axios.post(`${API_URL}/register`, { nickname, password });
        setNickname('');
        setPassword('');
        setIsLogin(true);
        setErrorMessage('');
        alert("Muvaffaqiyatli ro'yxatdan o'tdingiz! Endi kirish qiling.");
      }
    } catch (err) {
      setErrorMessage(err.response?.data?.message || 'Xatolik!');
    }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setErrorMessage('');

    try {
      const res = await axios.post(`${API_URL}/forgot-password`, { nickname });
      alert(res.data.message);
      setIsForgot(false);
    } catch (err) {
      setErrorMessage(err.response?.data?.message || 'Xatolik yuz berdi');
    }
  };

  const handleUpdateProfile = async (e) => {
    e.preventDefault();
    if (!user?.id) return;

    try {
      const res = await axios.put(`${API_URL}/update-profile`, {
        userId: user.id,
        newNickname,
        newPassword,
        newEmail,
      });

      const updatedUser = normalizeUser(res.data.user);
      setUser(updatedUser);
      userRef.current = updatedUser;
      localStorage.setItem(STORAGE.user, JSON.stringify(updatedUser));
      setNewPassword('');
      alert(res.data.message);
      setShowSettings(false);
    } catch (err) {
      alert(err.response?.data?.message || 'Yangilashda xato yuz berdi');
    }
  };

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    if (!newRoomName.trim() || !user?.id) return;

    try {
      const res = await axios.post(`${ROOM_URL}/create`, {
        name: newRoomName,
        type: newRoomType,
        topic: newRoomTopic,
        creatorId: user.id,
        username: newRoomUsername,
        description: newRoomDescription,
      });

      const createdRoom = normalizeRoom(res.data);
      setRoomList((prev) => addToTopUnique(createdRoom, prev));
      setActiveItem({
        type: 'room',
        id: createdRoom.id,
        label: createdRoom.name,
        roomType: createdRoom.type,
        creator: createdRoom.owner,
      });
      setRoomDetails(createdRoom);

      setShowCreateModal(false);
      setNewRoomName('');
      setNewRoomUsername('');
      setNewRoomTopic('');
      setNewRoomDescription('');
      setNewRoomType('group');
    } catch (err) {
      alert(err.response?.data?.message || 'Xona yaratishda xatolik');
    }
  };

  const handleSearchUser = async () => {
    if (!searchNickname.trim() || !user?.nickname) return;
    if (normalizeText(searchNickname) === normalizeText(user.nickname)) {
      alert("O'zingizni qidira olmaysiz");
      return;
    }

    try {
      const res = await axios.get(`${API_URL}/search/${searchNickname}`);
      const foundUser = normalizeUser(res.data);

      setChatList((prev) => addToTopUnique(foundUser, prev));
      setActiveItem({
        type: 'user',
        id: foundUser.id,
        label: foundUser.nickname,
      });

      setSearchNickname('');
    } catch (err) {
      alert(err.response?.data?.message || 'Foydalanuvchi topilmadi');
    }
  };

  const handleSearchRoomByUsername = async () => {
    if (!searchRoomUsername.trim()) return;

    try {
      const res = await axios.get(`${ROOM_URL}/by-username/${searchRoomUsername}`);
      const room = normalizeRoom(res.data);

      setRoomList((prev) => upsertUnique(room, prev));
      setActiveItem({
        type: 'room',
        id: room.id,
        label: room.name,
        roomType: room.type,
        creator: room.owner,
      });
      setShowSettings(false);
      setSearchRoomUsername('');
      setShowRoomInfo(false);
      await loadRoomDetails(room.id);
    } catch (err) {
      alert(err.response?.data?.message || 'Room topilmadi');
    }
  };

  const handleJoinByInviteCode = async () => {
    if (!joinInviteCode.trim() || !user?.id) return;

    try {
      await joinByInviteCode(joinInviteCode.trim(), user.id);
      setJoinInviteCode('');
      setShowRoomInfo(false);
    } catch (err) {
      alert(err.response?.data?.message || 'Invite code noto‘g‘ri');
    }
  };

  const handleJoinCurrentRoom = async () => {
    if (!user?.id || !activeItem?.id) return;

    try {
      const res = await axios.post(`${ROOM_URL}/${activeItem.id}/join`, {
        userId: user.id,
      });

      const updatedRoom = normalizeRoom(res.data.room);
      setRoomList((prev) => upsertUnique(updatedRoom, prev));
      setRoomDetails(updatedRoom);
      setActiveItem({
        type: 'room',
        id: updatedRoom.id,
        label: updatedRoom.name,
        roomType: updatedRoom.type,
        creator: updatedRoom.owner,
      });
      alert(res.data.message);
    } catch (err) {
      alert(err.response?.data?.message || 'Roomga qo‘shilishda xatolik');
    }
  };

  const handleLeaveRoom = async () => {
    if (!user?.id || !activeItem?.id) return;

    try {
      const res = await axios.delete(`${ROOM_URL}/${activeItem.id}/leave`, {
        data: { userId: user.id },
      });

      if (res.data.room) {
        const updatedRoom = normalizeRoom(res.data.room);
        setRoomList((prev) => prev.map((room) => (room.id === updatedRoom.id ? updatedRoom : room)));
        setRoomDetails(updatedRoom);
      } else {
        removeRoomFromLocalState(activeItem.id);
      }

      setActiveItem(null);
      setMessages([]);
      setShowRoomInfo(false);
      alert(res.data.message);
    } catch (err) {
      alert(err.response?.data?.message || 'Roomdan chiqishda xatolik');
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!activeItem || !user?.id || !socketRef.current) return;
    if (!messageText.trim() && !selectedMedia) return;

    if (activeItem.type === 'room' && roomDetails) {
      const allowed = canWriteRoom(roomDetails, user.id);
      if (!allowed) {
        alert('Bu roomda yozish huquqingiz yo‘q');
        return;
      }
    }

    const payload = {
      sender: user.id,
      messageText: messageText.trim(),
    };

    if (selectedMedia) {
      payload.mediaUrl = selectedMedia.dataUrl;
      payload.mediaType = 'image';
      payload.mediaName = selectedMedia.name;
    }

    if (replyToMessage?.id) payload.replyTo = replyToMessage.id;
    if (forwardMessage?.id) payload.forwardedFrom = forwardMessage.id;

    if (activeItem.type === 'room') {
      payload.room = activeItem.id;
    } else {
      payload.receiver = activeItem.id;
    }

    socketRef.current.emit('send_message', payload);
    setMessageText('');
    setReplyToMessage(null);
    setForwardMessage(null);
    setSelectedMedia(null);
    setMediaInputKey((prev) => prev + 1);
  };

  const handleDeleteChat = async () => {
    if (!user || !activeItem || activeItem.type !== 'user') return;

    try {
      await axios.delete(`${API_URL}/chats/${user.id}/${activeItem.id}`);
      setChatList((prev) => prev.filter((u) => u.id !== activeItem.id));
      setActiveItem(null);
      setMessages([]);
      localStorage.removeItem(STORAGE.activeItem);
    } catch (err) {
      alert(err.response?.data?.message || 'Chatni o‘chirishda xatolik');
    }
  };

  const handleDeleteRoom = async () => {
    if (!user || !activeItem || activeItem.type !== 'room') return;

    try {
      await axios.delete(`${ROOM_URL}/${activeItem.id}/${user.id}`);
      setRoomList((prev) => prev.filter((r) => r.id !== activeItem.id));
      setActiveItem(null);
      setMessages([]);
      setRoomDetails(null);
      setShowRoomInfo(false);
      localStorage.removeItem(STORAGE.activeItem);
    } catch (err) {
      alert(err.response?.data?.message || 'Roomni o‘chirishda xatolik');
    }
  };

  const handleUpdateRoomMeta = async () => {
    if (!user?.id || !activeItem?.id) return;

    try {
      const res = await axios.put(`${ROOM_URL}/${activeItem.id}/meta`, {
        userId: user.id,
        name: roomEditName,
        username: roomEditUsername,
        description: roomEditDescription,
        topic: roomEditTopic,
      });

      const updatedRoom = normalizeRoom(res.data.room);
      setRoomDetails(updatedRoom);
      setRoomList((prev) => prev.map((r) => (r.id === updatedRoom.id ? updatedRoom : r)));
      setActiveItem((prev) =>
        prev
          ? { ...prev, label: updatedRoom.name, roomType: updatedRoom.type, creator: updatedRoom.owner }
          : prev
      );
      alert(res.data.message);
    } catch (err) {
      alert(err.response?.data?.message || 'Room ma’lumotlarini yangilashda xatolik');
    }
  };

  const handleFindMember = async () => {
    if (!memberNickname.trim()) return;

    try {
      const res = await axios.get(`${API_URL}/search/${memberNickname}`);
      setMemberSearchResult(normalizeUser(res.data));
    } catch (err) {
      setMemberSearchResult(null);
      alert(err.response?.data?.message || 'Foydalanuvchi topilmadi');
    }
  };

  const handleAddMemberToRoom = async () => {
    if (!user?.id || !activeItem?.id || !memberSearchResult?.id) return;

    try {
      const res = await axios.post(`${ROOM_URL}/${activeItem.id}/members`, {
        userId: user.id,
        memberId: memberSearchResult.id,
      });

      const updatedRoom = normalizeRoom(res.data.room);
      setRoomDetails(updatedRoom);
      setRoomList((prev) => prev.map((room) => (room.id === activeItem.id ? updatedRoom : room)));

      setMemberNickname('');
      setMemberSearchResult(null);
    } catch (err) {
      alert(err.response?.data?.message || 'A’zo qo‘shishda xatolik');
    }
  };

  const handleRemoveMemberFromRoom = async (memberId) => {
    if (!user?.id || !activeItem?.id) return;

    try {
      const res = await axios.delete(`${ROOM_URL}/${activeItem.id}/members/${memberId}`, {
        data: { userId: user.id },
      });

      const updatedRoom = normalizeRoom(res.data.room);
      setRoomDetails(updatedRoom);
      setRoomList((prev) => prev.map((room) => (room.id === activeItem.id ? updatedRoom : room)));
    } catch (err) {
      alert(err.response?.data?.message || 'A’zo chiqarishda xatolik');
    }
  };

  const handleMakeAdmin = async (memberId) => {
    if (!user?.id || !activeItem?.id) return;

    try {
      const res = await axios.post(`${ROOM_URL}/${activeItem.id}/admins`, {
        userId: user.id,
        memberId,
      });

      const updatedRoom = normalizeRoom(res.data.room);
      setRoomDetails(updatedRoom);
      setRoomList((prev) => prev.map((room) => (room.id === activeItem.id ? updatedRoom : room)));
    } catch (err) {
      alert(err.response?.data?.message || 'Admin berishda xatolik');
    }
  };

  const handleRemoveAdmin = async (memberId) => {
    if (!user?.id || !activeItem?.id) return;

    try {
      const res = await axios.delete(`${ROOM_URL}/${activeItem.id}/admins/${memberId}`, {
        data: { userId: user.id },
      });

      const updatedRoom = normalizeRoom(res.data.room);
      setRoomDetails(updatedRoom);
      setRoomList((prev) => prev.map((room) => (room.id === activeItem.id ? updatedRoom : room)));
    } catch (err) {
      alert(err.response?.data?.message || 'Adminni olib tashlashda xatolik');
    }
  };

  const handleDeleteMessageForAll = (messageId) => {
    socketRef.current?.emit('message_delete_all', {
      messageId,
      userId: user?.id,
    });
  };

  const handleReactMessage = (messageId, emoji) => {
    socketRef.current?.emit('message_react', {
      messageId,
      userId: user?.id,
      emoji,
    });
  };

  const handleCopyInviteLink = async () => {
    if (!roomDetails?.inviteCode) return;
    const text = `${window.location.origin}/join/${roomDetails.inviteCode}`;
    try {
      await navigator.clipboard.writeText(text);
      alert('Invite link copied');
    } catch {
      alert(text);
    }
  };

  const handleScrollToMessage = (messageId) => {
    const id = getId(messageId);
    if (!id) return;

    const el = messageRefs.current[id] || document.getElementById(`msg-${id}`);
    if (!el) return;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMessageId(id);
    setTimeout(() => {
      setHighlightedMessageId((prev) => (prev === id ? '' : prev));
    }, 1500);
  };

  const resolveReplyTarget = (replyTo) => {
    if (!replyTo) return null;
    const id = getId(replyTo.id || replyTo);
    if (!id) return null;
    return messages.find((m) => sameId(m.id, id)) || null;
  };

  const changeLang = (lang) => {
    i18n.changeLanguage(lang);
    localStorage.setItem(STORAGE.lang, lang);
  };

  const handleLogout = () => {
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    clearSession();

    setUser(null);
    userRef.current = null;
    setToken('');
    setChatList([]);
    setRoomList([]);
    setActiveItem(null);
    setMessages([]);
    setMessageText('');
    setSearchNickname('');
    setSearchRoomUsername('');
    setShowSettings(false);
    setShowCreateModal(false);
    setIsForgot(false);
    setNickname('');
    setPassword('');
    setNewNickname('');
    setNewPassword('');
    setNewEmail('');
    setDeletePassword('');
    setShowDeleteAccountModal(false);
    setShowRoomInfo(false);
    setRoomDetails(null);
    setRoomEditName('');
    setRoomEditUsername('');
    setRoomEditDescription('');
    setRoomEditTopic('');
    setMemberNickname('');
    setMemberSearchResult(null);
    setReplyToMessage(null);
    setForwardMessage(null);
    setJoinInviteCode('');
    setSelectedMedia(null);
    setMediaInputKey((prev) => prev + 1);
  };

  const handleMediaChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Hozir faqat rasm yuborish mumkin');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setSelectedMedia({
        dataUrl: String(reader.result || ''),
        name: file.name,
        type: file.type,
      });
    };
    reader.readAsDataURL(file);
  };

  const currentRole = roomDetails ? getRoomRole(roomDetails, user?.id) : null;
  const isOwner = currentRole === 'owner';
  const isAdmin = currentRole === 'admin' || currentRole === 'owner';
  const canAddPeople = !!currentRole;
  const canSendInRoom = activeItem?.type === 'room'
    ? (roomDetails?.type === 'group' ? !!currentRole : isAdmin)
    : true;

  const activeHeaderText = useMemo(() => {
    if (!activeItem) return '';
    if (activeItem.type === 'room') {
      const prefix = activeItem.roomType === 'channel' ? '#' : '👥';
      return `${prefix} ${activeItem.label || activeItem.id}`;
    }
    return `@${activeItem.label || activeItem.id}`;
  }, [activeItem]);

  const pinnedMessages = useMemo(() => {
    const pinnedIds = new Set((roomDetails?.pinnedMessages || []).map(getId));
    return messages.filter((m) => pinnedIds.has(getId(m)));
  }, [messages, roomDetails]);

  const roomInfoMembers = (roomDetails?.members || []).map((m) => ({
    user: normalizeUser(m.user || m),
    role: m.role || 'member',
  }));

  if (!user) {
    return (
      <div className="auth-page">
        <style>{`
          :root { --bg:#0b141a; --panel:#111b21; --border:#2a3942; --muted:#8696a0; --accent:#00a884; --text:#e9edef; }
          * { box-sizing:border-box; }
          body { margin:0; background:var(--bg); color:var(--text); font-family: Inter, Arial, sans-serif; overflow:hidden; }
          .auth-page, .chat-layout { width:100vw; height:100vh; background:var(--bg); }
          .auth-wrapper { height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; }
          .auth-container { width:min(440px, calc(100vw - 32px)); padding:28px; background:var(--panel); border-radius:20px; box-shadow:0 20px 60px rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.04); }
          .auth-container h2, .auth-container h3 { margin-top:0; }
          .auth-container input, .auth-container select, .auth-container textarea {
            width:100%; padding:12px 14px; background:#2a3942; border:1px solid #3c4b55;
            color:var(--text); border-radius:12px; outline:none; margin:8px 0 14px;
          }
          .auth-container textarea { min-height:90px; resize:vertical; }
          .auth-container button, .primary-btn {
            background:var(--accent); color:white; border:none; border-radius:12px; padding:12px 14px; cursor:pointer; font-weight:700;
          }
          .ghost-btn { background:#2a3942; color:white; border:none; border-radius:12px; padding:10px 12px; cursor:pointer; }
          .danger-btn { background:#ef4444; color:white; border:none; border-radius:12px; padding:10px 12px; cursor:pointer; }
          .lang-row { display:flex; gap:10px; justify-content:center; margin-bottom:20px; }
          .lang-chip { cursor:pointer; font-weight:700; color:var(--muted); }
          .lang-chip.active { color:var(--accent); }
        `}</style>

        <div className="auth-wrapper">
          <div className="auth-container">
            <div className="lang-row">
              <span className={`lang-chip ${i18n.language === 'uz' ? 'active' : ''}`} onClick={() => changeLang('uz')}>UZ</span>
              <span className={`lang-chip ${i18n.language === 'ru' ? 'active' : ''}`} onClick={() => changeLang('ru')}>RU</span>
              <span className={`lang-chip ${i18n.language === 'en' ? 'active' : ''}`} onClick={() => changeLang('en')}>EN</span>
            </div>

            {isForgot ? (
              <>
                <h2>{t('forgot_password')}</h2>
                {errorMessage && <p style={{ color: '#ef4444', marginBottom: '10px' }}>{errorMessage}</p>}
                <form onSubmit={handleForgotPassword}>
                  <input
                    type="text"
                    placeholder={t('placeholder_nickname')}
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    required
                  />
                  <button type="submit" style={{ width: '100%' }}>{t('send')}</button>
                </form>
                <p
                  onClick={() => { setIsForgot(false); setErrorMessage(''); }}
                  style={{ marginTop: '15px', cursor: 'pointer', color: '#00a884' }}
                >
                  {t('back')}
                </p>
              </>
            ) : (
              <>
                <h2>{isLogin ? t('login') : t('register')}</h2>
                {errorMessage && <p style={{ color: '#ef4444', marginBottom: '10px' }}>{errorMessage}</p>}
                <form onSubmit={handleAuth}>
                  <input
                    type="text"
                    placeholder={t('placeholder_nickname')}
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    required
                  />
                  <input
                    type="password"
                    placeholder={t('placeholder_password')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button type="submit" style={{ width: '100%' }}>
                    {isLogin ? t('login') : t('register')}
                  </button>
                </form>

                {isLogin && (
                  <p
                    onClick={() => { setIsForgot(true); setErrorMessage(''); }}
                    style={{ color: '#00a884', fontSize: '13px', marginTop: '10px', cursor: 'pointer' }}
                  >
                    {t('forgot_password')}
                  </p>
                )}

                <p
                  onClick={() => { setIsLogin(!isLogin); setErrorMessage(''); }}
                  style={{ marginTop: '15px', cursor: 'pointer', color: '#00a884' }}
                >
                  {isLogin ? t('register') : t('login')}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-layout">
      <style>{`
        :root { --bg:#0b141a; --panel:#111b21; --border:#2a3942; --muted:#8696a0; --accent:#00a884; --text:#e9edef; }
        * { box-sizing:border-box; }
        body { margin:0; background:var(--bg); color:var(--text); font-family: Inter, Arial, sans-serif; overflow:hidden; }
        .chat-layout { display:flex; width:100vw; height:100vh; background:var(--bg); }
        .sidebar { height:100vh; background:var(--panel); border-right:1px solid var(--border); display:flex; flex-direction:column; overflow:hidden; }
        .sidebar-inner { padding:16px; overflow:auto; height:100%; }
        .resizer { width:6px; cursor:col-resize; background:transparent; }
        .resizer:hover { background:rgba(255,255,255,.06); }
        .chat-area { flex:1; display:flex; flex-direction:column; height:100vh; background:#0b141a; }
        .chat-header { min-height:64px; display:flex; align-items:center; justify-content:space-between; padding:0 20px; border-bottom:1px solid var(--border); background:rgba(17,27,33,.75); backdrop-filter: blur(10px); font-weight:700; gap:16px; cursor:pointer; }
        .messages-container { flex:1; overflow:auto; padding:20px; display:flex; flex-direction:column; gap:10px; }
        .message { max-width:min(72%, 720px); padding:10px 14px; border-radius:14px; line-height:1.4; word-break:break-word; white-space:pre-wrap; position:relative; }
        .message.sent { align-self:flex-end; background:#005c4b; }
        .message.received { align-self:flex-start; background:#202c33; }
        .message.highlighted { outline:2px solid #00a884; box-shadow:0 0 0 2px rgba(0, 168, 132, .25); }
        .message-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
        .msg-btn { border:none; background:#2a3942; color:#e9edef; border-radius:10px; padding:6px 8px; cursor:pointer; font-size:12px; }
        .input-area { display:flex; gap:10px; padding:16px; border-top:1px solid var(--border); background:rgba(17,27,33,.9); align-items:center; }
        .input-area input[type="text"] {
          flex:1; width:100%; padding:12px 14px; background:#2a3942; border:1px solid #3c4b55;
          color:var(--text); border-radius:12px; outline:none;
        }
        .primary-btn { background:var(--accent); color:white; border:none; border-radius:12px; padding:12px 14px; cursor:pointer; font-weight:700; }
        .ghost-btn { background:#2a3942; color:white; border:none; border-radius:12px; padding:10px 12px; cursor:pointer; }
        .danger-btn { background:#ef4444; color:white; border:none; border-radius:12px; padding:10px 12px; cursor:pointer; }
        .chip { display:flex; align-items:center; gap:10px; padding:12px; border-radius:12px; cursor:pointer; margin-bottom:6px; }
        .chip.active { background:#2a3942; }
        .muted { color:var(--muted); }
        .section-title { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:18px 0 8px; }
        .stack { display:flex; gap:10px; flex-wrap:wrap; }
        .list-scroll { max-height: calc(100vh - 220px); overflow:auto; padding-right:4px; }
        .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.72); display:flex; align-items:center; justify-content:center; z-index:1000; padding:16px; }
        .modal-card { width:min(760px, 100%); max-height:calc(100vh - 32px); overflow:auto; background:var(--panel); border-radius:20px; padding:22px; border:1px solid rgba(255,255,255,.04); box-shadow:0 20px 60px rgba(0,0,0,.35); }
        .modal-card input, .modal-card select, .modal-card textarea {
          width:100%; padding:12px 14px; background:#2a3942; border:1px solid #3c4b55;
          color:var(--text); border-radius:12px; outline:none; margin:8px 0 14px;
        }
        .modal-card textarea { min-height:92px; resize:vertical; }
        .badge { display:inline-flex; align-items:center; padding:4px 8px; border-radius:999px; font-size:12px; background:#2a3942; color:#e9edef; margin-left:8px; }
        .small { font-size:12px; color:var(--muted); }
        .reply-box { padding:10px 12px; background:#17232c; border:1px solid #2a3942; border-radius:12px; margin:0 16px 10px; display:flex; justify-content:space-between; gap:12px; align-items:center; }
        .emoji-row { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
        .media-preview { width:100%; max-width:220px; border-radius:12px; display:block; margin-top:8px; }
      `}</style>

      <div className="sidebar" style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }}>
        <div className="sidebar-inner">
          <div style={{ marginBottom: '15px', borderBottom: '1px solid #2a3942', paddingBottom: '15px' }}>
            <h3 style={{ marginTop: 0 }}>{t('welcome')}, @{user.nickname}!</h3>
            <div className="stack">
              <button className="ghost-btn" onClick={() => setShowSettings((prev) => !prev)}>
                {showSettings ? t('back') : t('settings')}
              </button>
              <button className="danger-btn" onClick={handleLogout}>{t('logout')}</button>
            </div>
          </div>

          {showSettings ? (
            <div>
              <form onSubmit={handleUpdateProfile}>
                <label className="muted" style={{ fontSize: '12px' }}>{t('username_label')}</label>
                <input
                  type="text"
                  value={newNickname}
                  onChange={(e) => setNewNickname(e.target.value)}
                  placeholder={t('placeholder_nickname')}
                />

                <label className="muted" style={{ fontSize: '12px' }}>{t('email_label')}</label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder={t('placeholder_email')}
                />

                <label className="muted" style={{ fontSize: '12px' }}>{t('new_password_label')}</label>
                <input
                  type="password"
                  placeholder={t('placeholder_new_password')}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />

                <div style={{ marginTop: '15px', marginBottom: '15px' }}>
                  <p className="section-title" style={{ marginTop: 0 }}>{t('select_lang')}</p>
                  <div className="stack">
                    <button type="button" className="ghost-btn" onClick={() => changeLang('uz')}>UZ</button>
                    <button type="button" className="ghost-btn" onClick={() => changeLang('ru')}>RU</button>
                    <button type="button" className="ghost-btn" onClick={() => changeLang('en')}>EN</button>
                  </div>
                </div>

                <button type="submit" className="primary-btn" style={{ width: '100%' }}>
                  {t('save')}
                </button>

                <button
                  type="button"
                  className="danger-btn"
                  style={{ width: '100%', marginTop: '12px' }}
                  onClick={() => setShowDeleteAccountModal(true)}
                >
                  Accountni o‘chirish
                </button>
              </form>
            </div>
          ) : (
            <div className="list-scroll">
              <button
                onClick={() => setShowCreateModal(true)}
                className="ghost-btn"
                style={{ width: '100%', textAlign: 'left', marginBottom: '15px', fontWeight: 700 }}
              >
                ➕ {t('create_room')}
              </button>

              <h4 className="section-title">{t('search_user')}</h4>
              <input
                type="text"
                placeholder={t('placeholder_nickname')}
                value={searchNickname}
                onChange={(e) => setSearchNickname(e.target.value)}
              />
              <button
                onClick={handleSearchUser}
                className="primary-btn"
                style={{ width: '100%', marginBottom: '15px' }}
              >
                {t('start_chat')}
              </button>

              <h4 className="section-title">{t('room_username')} {t('search')}</h4>
              <input
                type="text"
                placeholder={t('room_username')}
                value={searchRoomUsername}
                onChange={(e) => setSearchRoomUsername(e.target.value)}
              />
              <button
                onClick={handleSearchRoomByUsername}
                className="primary-btn"
                style={{ width: '100%', marginBottom: '15px' }}
              >
                {t('search')}
              </button>

              <h4 className="section-title">{t('join_room')} {t('copy_link')}</h4>
              <input
                type="text"
                placeholder="invite code"
                value={joinInviteCode}
                onChange={(e) => setJoinInviteCode(e.target.value)}
              />
              <button
                onClick={handleJoinByInviteCode}
                className="ghost-btn"
                style={{ width: '100%', marginBottom: '15px' }}
              >
                {t('join_room')}
              </button>

              {roomList.length > 0 && <h4 className="section-title">{t('channels_groups')}</h4>}
              {roomList.map((room) => {
                const memberCount = Array.isArray(room.members) ? room.members.length : 0;
                return (
                  <div
                    key={room.id}
                    onClick={() => {
                      setShowSettings(false);
                      setActiveItem({
                        type: 'room',
                        id: room.id,
                        label: room.name,
                        roomType: room.type,
                        creator: room.owner,
                      });
                      setShowRoomInfo(false);
                      loadRoomDetails(room.id);
                    }}
                    className={`chip ${activeItem?.type === 'room' && sameId(activeItem.id, room.id) ? 'active' : ''}`}
                  >
                    <span style={{ color: '#81a1c1' }}>{room.type === 'channel' ? '#' : '👥'}</span>
                    <span style={{ display: 'flex', flexDirection: 'column' }}>
                      <span>{room.name}</span>
                      <span className="small">{memberCount} {t('members')}</span>
                    </span>
                  </div>
                );
              })}

              <h4 className="section-title">{t('direct_messages')}</h4>
              {chatList.map((chatUser) => (
                <div
                  key={chatUser.id}
                  onClick={() => {
                    setShowSettings(false);
                    setActiveItem({
                      type: 'user',
                      id: chatUser.id,
                      label: chatUser.nickname,
                    });
                    setShowRoomInfo(false);
                  }}
                  className={`chip ${activeItem?.type === 'user' && sameId(activeItem.id, chatUser.id) ? 'active' : ''}`}
                >
                  <span style={{ color: '#00a884' }}>●</span>
                  <span>@{chatUser.nickname}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="resizer" onMouseDown={() => { isResizing.current = true; document.body.style.cursor = 'col-resize'; }} />

      <div className="chat-area">
        {activeItem ? (
          <>
            <div
              className="chat-header"
              onClick={() => {
                if (activeItem.type === 'room') {
                  setShowRoomInfo(true);
                  loadRoomDetails(activeItem.id);
                }
              }}
              title={activeItem.type === 'room' ? 'Room info' : ''}
            >
              <span>{activeHeaderText}</span>

              <div className="stack" onClick={(e) => e.stopPropagation()}>
                {activeItem.type === 'user' && (
                  <button className="ghost-btn" onClick={handleDeleteChat}>
                    {t('remove')}
                  </button>
                )}

                {activeItem.type === 'room' && isOwner && (
                  <button className="danger-btn" onClick={handleDeleteRoom}>
                    {t('remove')}
                  </button>
                )}
              </div>
            </div>

            {replyToMessage && (
              <div className="reply-box">
                <div>
                  <div className="small">Replying to</div>
                  <div style={{ fontWeight: 700 }}>
                    {replyToMessage.sender?.nickname ? `@${replyToMessage.sender.nickname}` : '@unknown'}
                  </div>
                  <div>{replyToMessage.deletedForAll ? '[deleted]' : replyToMessage.messageText}</div>
                </div>
                <button className="ghost-btn" type="button" onClick={() => setReplyToMessage(null)}>
                  {t('cancel')}
                </button>
              </div>
            )}

            {forwardMessage && (
              <div className="reply-box">
                <div>
                  <div className="small">Forward draft</div>
                  <div style={{ fontWeight: 700 }}>
                    {forwardMessage.sender?.nickname ? `@${forwardMessage.sender.nickname}` : '@unknown'}
                  </div>
                  <div>{forwardMessage.deletedForAll ? '[deleted]' : forwardMessage.messageText}</div>
                </div>
                <button className="ghost-btn" type="button" onClick={() => setForwardMessage(null)}>
                  {t('cancel')}
                </button>
              </div>
            )}

            {selectedMedia && (
              <div className="reply-box" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="small">Selected image</div>
                  <div style={{ fontWeight: 700 }}>{selectedMedia.name}</div>
                  <img src={selectedMedia.dataUrl} alt={selectedMedia.name} className="media-preview" />
                </div>
                <button
                  className="ghost-btn"
                  type="button"
                  onClick={() => {
                    setSelectedMedia(null);
                    setMediaInputKey((prev) => prev + 1);
                  }}
                >
                  {t('cancel')}
                </button>
              </div>
            )}

            <div className="messages-container">
              {pinnedMessages.length > 0 && (
                <div style={{ padding: '10px 12px', border: '1px solid #2a3942', borderRadius: '12px', marginBottom: '12px', background: '#111b21' }}>
                  <div className="small" style={{ marginBottom: '6px' }}>Pinned messages</div>
                  {pinnedMessages.map((p) => (
                    <div key={p.id} style={{ fontSize: '13px', marginBottom: '4px' }}>
                      • {p.deletedForAll ? '[deleted]' : p.messageText || p.mediaName || 'media'}
                    </div>
                  ))}
                </div>
              )}

              {messages.map((msg) => {
                const currentUserId = user.id;
                const senderId = getId(msg.sender);
                const isMe = sameId(senderId, currentUserId);
                const canDelete = isMe || (activeItem.type === 'room' && isOwner);
                const roomPinned = roomDetails?.pinnedMessages?.some((id) => sameId(id, msg.id));

                const resolvedReply = resolveReplyTarget(msg.replyTo);
                const resolvedForward = resolveReplyTarget(msg.forwardedFrom);

                const groupedReactions = (msg.reactions || []).reduce((acc, r) => {
                  acc[r.emoji] = acc[r.emoji] || [];
                  acc[r.emoji].push(r.user);
                  return acc;
                }, {});

                return (
                  <div
                    key={msg.id}
                    id={`msg-${msg.id}`}
                    ref={(el) => {
                      if (el) messageRefs.current[msg.id] = el;
                    }}
                    className={`message ${isMe ? 'sent' : 'received'} ${highlightedMessageId === msg.id ? 'highlighted' : ''}`}
                  >
                    {activeItem.type === 'room' && !isMe && msg.sender?.nickname && (
                      <span style={{ display: 'block', fontSize: '11px', color: '#81a1c1', marginBottom: '3px' }}>
                        @{msg.sender.nickname}
                      </span>
                    )}

                    {msg.replyTo && (
                      <button
                        type="button"
                        onClick={() => handleScrollToMessage(msg.replyTo.id || msg.replyTo)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          fontSize: '12px',
                          opacity: 0.9,
                          borderLeft: '3px solid #8696a0',
                          paddingLeft: '8px',
                          marginBottom: '8px',
                          background: 'transparent',
                          color: 'inherit',
                          borderTop: 'none',
                          borderRight: 'none',
                          borderBottom: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        Reply to:{' '}
                        {resolvedReply?.sender?.nickname ? `@${resolvedReply.sender.nickname}` : ''}
                        {' '}
                        {resolvedReply?.deletedForAll
                          ? '[deleted]'
                          : (resolvedReply?.messageText || resolvedReply?.mediaName || '[message]')}
                      </button>
                    )}

                    {msg.forwardedFrom && (
                      <div style={{ fontSize: '12px', opacity: 0.85, marginBottom: '8px' }}>
                        Forwarded from{' '}
                        {resolvedForward?.sender?.nickname ? `@${resolvedForward.sender.nickname}` : ''}
                        {' '}
                        {resolvedForward?.deletedForAll
                          ? '[deleted]'
                          : (resolvedForward?.messageText || resolvedForward?.mediaName || '[message]')}
                      </div>
                    )}

                    {msg.mediaUrl && msg.mediaType === 'image' && (
                      <img
                        src={msg.mediaUrl}
                        alt={msg.mediaName || 'image'}
                        style={{ maxWidth: '100%', borderRadius: '12px', display: 'block', marginBottom: msg.messageText ? '8px' : '0' }}
                      />
                    )}

                    <div>
                      {msg.deletedForAll
                        ? '[deleted]'
                        : (msg.messageText || (msg.mediaUrl ? msg.mediaName || 'image' : ''))}
                    </div>

                    {Object.keys(groupedReactions).length > 0 && (
                      <div className="emoji-row">
                        {Object.entries(groupedReactions).map(([emoji, users]) => (
                          <span key={emoji} className="badge">
                            {emoji} {users.length}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="message-actions">
                      <button className="msg-btn" type="button" onClick={() => setReplyToMessage(msg)}>{t('back')}</button>
                      <button className="msg-btn" type="button" onClick={() => setForwardMessage(msg)}>Forward</button>

                      {EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          className="msg-btn"
                          type="button"
                          onClick={() => handleReactMessage(msg.id, emoji)}
                        >
                          {emoji}
                        </button>
                      ))}

                      {activeItem.type === 'room' && isAdmin && !roomPinned && (
                        <button
                          className="msg-btn"
                          type="button"
                          onClick={() => axios.post(`${ROOM_URL}/${activeItem.id}/pin/${msg.id}`, { userId: user.id }).then(() => loadRoomDetails(activeItem.id))}
                        >
                          Pin
                        </button>
                      )}

                      {activeItem.type === 'room' && isAdmin && roomPinned && (
                        <button
                          className="msg-btn"
                          type="button"
                          onClick={() => axios.delete(`${ROOM_URL}/${activeItem.id}/pin/${msg.id}`, { data: { userId: user.id } }).then(() => loadRoomDetails(activeItem.id))}
                        >
                          Unpin
                        </button>
                      )}

                      {canDelete && (
                        <button className="msg-btn" type="button" onClick={() => handleDeleteMessageForAll(msg.id)}>
                          Delete for all
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <form onSubmit={handleSendMessage} className="input-area">
              <input
                key={mediaInputKey}
                type="file"
                accept="image/*"
                onChange={handleMediaChange}
                style={{ maxWidth: '180px', background: 'transparent', border: 'none', padding: '0', color: '#e9edef' }}
              />
              <input
                type="text"
                placeholder={activeItem.type === 'room' && roomDetails?.type === 'channel' && !canWriteRoom(roomDetails, user.id) ? 'Only admin can write here' : '...'}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                disabled={activeItem.type === 'room' && roomDetails?.type === 'channel' && !canWriteRoom(roomDetails, user.id)}
              />
              <button
                type="submit"
                className="primary-btn"
                disabled={activeItem.type === 'room' && roomDetails?.type === 'channel' && !canWriteRoom(roomDetails, user.id)}
              >
                {t('send')}
              </button>
            </form>
          </>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: '#8696a0', fontSize: '16px' }}>
            {t('empty_chat')}
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h3 style={{ margin: 0 }}>{t('create_room')}</h3>
              <span onClick={() => setShowCreateModal(false)} style={{ cursor: 'pointer', fontSize: '24px', color: '#8696a0' }}>
                &times;
              </span>
            </div>

            <form onSubmit={handleCreateRoom}>
              <label className="muted" style={{ fontSize: '13px' }}>{t('room_name_label')}</label>
              <input
                type="text"
                placeholder={t('room_name_required')}
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                required
              />

              <label className="muted" style={{ fontSize: '13px' }}>{t('room_username')}</label>
              <input
                type="text"
                placeholder="news_uz"
                value={newRoomUsername}
                onChange={(e) => setNewRoomUsername(e.target.value)}
              />

              <label className="muted" style={{ fontSize: '13px' }}>{t('description')}</label>
              <textarea
                placeholder={t('description')}
                value={newRoomDescription}
                onChange={(e) => setNewRoomDescription(e.target.value)}
              />

              <label className="muted" style={{ fontSize: '13px' }}>{t('topic')}</label>
              <input
                type="text"
                placeholder={t('topic')}
                value={newRoomTopic}
                onChange={(e) => setNewRoomTopic(e.target.value)}
              />

              <label className="muted" style={{ fontSize: '13px' }}>{t('room_type_label')}</label>
              <select value={newRoomType} onChange={(e) => setNewRoomType(e.target.value)}>
                <option value="group">👥 Group</option>
                <option value="channel"># Channel</option>
              </select>

              <div className="stack" style={{ justifyContent: 'flex-end', marginTop: '10px' }}>
                <button type="button" className="ghost-btn" onClick={() => setShowCreateModal(false)}>
                  {t('cancel')}
                </button>
                <button type="submit" className="primary-btn">
                  {t('create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showDeleteAccountModal && (
        <div className="modal-backdrop">
          <div className="modal-card" style={{ width: 'min(460px, 100%)' }}>
            <h3>Accountni o‘chirish</h3>
            <p style={{ color: '#8696a0' }}>
              Bu amal qaytarilmaydi. Davom etish uchun joriy parolni kiriting.
            </p>

            <form onSubmit={(e) => {
              e.preventDefault();
              axios.delete(`${API_URL}/delete-account`, {
                data: { userId: user.id, password: deletePassword },
              })
                .then(() => {
                  setDeletePassword('');
                  setShowDeleteAccountModal(false);
                  handleLogout();
                  alert("Account o‘chirildi");
                })
                .catch((err) => alert(err.response?.data?.message || 'Accountni o‘chirishda xatolik'));
            }}>
              <input
                type="password"
                placeholder="Joriy parol"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                required
              />

              <div className="stack" style={{ justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setShowDeleteAccountModal(false);
                    setDeletePassword('');
                  }}
                >
                  {t('cancel')}
                </button>

                <button type="submit" className="danger-btn">
                  {t('remove')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showRoomInfo && activeItem?.type === 'room' && roomDetails && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h3 style={{ margin: 0 }}>
                {roomDetails.type === 'channel' ? '#' : '👥'} {roomDetails.name}
              </h3>
              <span onClick={() => setShowRoomInfo(false)} style={{ cursor: 'pointer', fontSize: '24px', color: '#8696a0' }}>
                &times;
              </span>
            </div>

            <div className="small" style={{ marginBottom: '8px' }}>
              {roomDetails.members?.length || 0} {t('members')}
            </div>

            <div className="small" style={{ marginBottom: '12px' }}>
              Username: @{roomDetails.username || 'no-username'}
            </div>

            <div className="small" style={{ marginBottom: '12px' }}>
              Invite code: {roomDetails.inviteCode || '-'}
              <button type="button" className="ghost-btn" style={{ marginLeft: '10px' }} onClick={handleCopyInviteLink}>
                {t('copy_link')}
              </button>
            </div>

            <div className="stack" style={{ marginBottom: '16px' }}>
              {currentRole ? (
                <button type="button" className="danger-btn" onClick={handleLeaveRoom}>
                  {t('leave_room')}
                </button>
              ) : (
                <button type="button" className="primary-btn" onClick={handleJoinCurrentRoom}>
                  {t('join_room')}
                </button>
              )}

              <button type="button" className="ghost-btn" onClick={handleCopyInviteLink}>
                {t('copy_link')}
              </button>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label className="muted" style={{ fontSize: '13px' }}>{t('description')}</label>
              <textarea
                value={roomEditDescription}
                onChange={(e) => setRoomEditDescription(e.target.value)}
                disabled={!isAdmin}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label className="muted" style={{ fontSize: '13px' }}>{t('topic')}</label>
              <input
                type="text"
                value={roomEditTopic}
                onChange={(e) => setRoomEditTopic(e.target.value)}
                disabled={!isAdmin}
              />

              <label className="muted" style={{ fontSize: '13px' }}>{t('room_name_label')}</label>
              <input
                type="text"
                value={roomEditName}
                onChange={(e) => setRoomEditName(e.target.value)}
                disabled={!isAdmin}
              />

              <label className="muted" style={{ fontSize: '13px' }}>{t('room_username')}</label>
              <input
                type="text"
                value={roomEditUsername}
                onChange={(e) => setRoomEditUsername(e.target.value)}
                disabled={!isAdmin}
              />

              {isAdmin && (
                <button type="button" className="primary-btn" style={{ width: '100%' }} onClick={handleUpdateRoomMeta}>
                  {t('save_changes')}
                </button>
              )}
            </div>

            <div style={{ marginBottom: '18px' }}>
              <h4 className="section-title" style={{ marginTop: 0 }}>{t('add_member')}</h4>
              <input
                type="text"
                placeholder={t('search')}
                value={memberNickname}
                onChange={(e) => setMemberNickname(e.target.value)}
                disabled={!canAddPeople}
              />
              <button type="button" className="primary-btn" style={{ width: '100%' }} onClick={handleFindMember} disabled={!canAddPeople}>
                {t('search')}
              </button>

              {memberSearchResult && canAddPeople && (
                <div style={{ marginTop: '12px', padding: '12px', borderRadius: '12px', background: '#2a3942' }}>
                  <div style={{ marginBottom: '8px' }}>
                    @{memberSearchResult.nickname}
                  </div>
                  <button type="button" className="primary-btn" onClick={handleAddMemberToRoom}>
                    {t('add_member')}
                  </button>
                </div>
              )}
            </div>

            <div>
              <h4 className="section-title" style={{ marginTop: 0 }}>{t('members')}</h4>
              <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                {roomInfoMembers.map((member) => {
                  const memberId = member.user.id;
                  const isCreator = sameId(getRoomOwnerId(roomDetails), memberId);
                  const isMemberAdmin = member.role === 'admin';
                  const isCurrentUser = sameId(memberId, user.id);

                  return (
                    <div
                      key={memberId}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 0',
                        borderBottom: '1px solid #2a3942',
                        gap: '10px',
                      }}
                    >
                      <div>
                        @{member.user.nickname}
                        {isCreator && <span className="badge">owner</span>}
                        {isMemberAdmin && !isCreator && <span className="badge">admin</span>}
                        {isCurrentUser && <span className="badge">you</span>}
                      </div>

                      {isOwner && !isCreator && (
                        <div className="stack">
                          {isMemberAdmin ? (
                            <button type="button" className="ghost-btn" onClick={() => handleRemoveAdmin(memberId)}>
                              {t('remove_admin')}
                            </button>
                          ) : (
                            <button type="button" className="ghost-btn" onClick={() => handleMakeAdmin(memberId)}>
                              {t('make_admin')}
                            </button>
                          )}

                          <button
                            type="button"
                            className="danger-btn"
                            onClick={() => handleRemoveMemberFromRoom(memberId)}
                          >
                            {t('remove')}
                          </button>
                        </div>
                      )}

                      {!isOwner && isAdmin && !isCreator && (
                        <button
                          type="button"
                          className="danger-btn"
                          onClick={() => handleRemoveMemberFromRoom(memberId)}
                        >
                          {t('remove')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;