import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import { useTranslation } from 'react-i18next';

const API_BASE = import.meta.env.VITE_API_URL || 'https://chat-backend-gukk.onrender.com';
const ROOM_BASE = import.meta.env.VITE_ROOM_URL || API_BASE;
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || API_BASE;

const API_URL = `${API_BASE}/api/auth`;
const ROOM_URL = `${ROOM_BASE}/api/rooms`;

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

/**
 * JWT tokenning muddati o'tganligini tekshiradi.
 * Signaturani tekshirmaydi — faqat exp claimni decode qiladi.
 * @param {string} token - JWT token
 * @returns {boolean} - true agar token haqiqiy va muddati o'tmagan bo'lsa
 */
const isTokenValid = (token) => {
  if (!token || typeof token !== 'string') return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return true; // exp maydoni yo'q bo'lsa, muddatsiz deb hisoblaymiz
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
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
    avatar: user.avatar || '',
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
  const [newAvatar, setNewAvatar] = useState('');
  const [deletePassword, setDeletePassword] = useState('');

  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomType, setNewRoomType] = useState('group');
  const [newRoomTopic, setNewRoomTopic] = useState('');
  const [newRoomUsername, setNewRoomUsername] = useState('');
  const [newRoomDescription, setNewRoomDescription] = useState('');

  const [chatList, setChatList] = useState([]);
  const [roomList, setRoomList] = useState([]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [searchNickname, setSearchNickname] = useState('');
  const [searchRoomUsername, setSearchRoomUsername] = useState('');
  const [joinInviteCode, setJoinInviteCode] = useState('');
  const [copiedInvite, setCopiedInvite] = useState(false);

  const [activeItem, setActiveItem] = useState(null);
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState([]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem(STORAGE.sidebarWidth));
    return Number.isFinite(saved) && saved >= 220 ? saved : 320;
  });

  const [roomDetails, setRoomDetails] = useState(null);
  const [roomEditName, setRoomEditName] = useState('');
  const [roomEditUsername, setRoomEditUsername] = useState('');
  const [roomEditDescription, setRoomEditDescription] = useState('');
  const [roomEditTopic, setRoomEditTopic] = useState('');
  const [memberNickname, setMemberNickname] = useState('');
  const [memberSearchResult, setMemberSearchResult] = useState(null);
  const [replyToMessage, setReplyToMessage] = useState(null);
  const [showForwardModal, setShowForwardModal] = useState(false);
  const [messageToForward, setMessageToForward] = useState(null);
  const [forwardSearchQuery, setForwardSearchQuery] = useState('');
  const [highlightedMessageId, setHighlightedMessageId] = useState('');
  const [selectedMedia, setSelectedMedia] = useState(null);
  const [mediaInputKey, setMediaInputKey] = useState(0);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [mobilePane, setMobilePane] = useState('sidebar');
  const [chatDeleteNotification, setChatDeleteNotification] = useState(null);

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
      const rawData = Array.isArray(res.data) ? res.data : [];
      const fetched = rawData.map(normalizeUser).filter(Boolean);
      setChatList((prev) => dedupeById([...fetched, ...prev]));
      // Initialize unread counts from API response
      setUnreadCounts((prev) => {
        const updated = { ...prev };
        rawData.forEach((item) => {
          const id = getId(item);
          if (id && typeof item.unreadCount === 'number') {
            updated[id] = item.unreadCount;
          }
        });
        return updated;
      });
    } catch {
      const cached = safeJsonParse(localStorage.getItem(STORAGE.chatList), []);
      setChatList(Array.isArray(cached) ? cached.map(normalizeUser).filter(Boolean) : []);
    }
  };

  const fetchRoomsList = async (userId) => {
    try {
      const res = await axios.get(`${ROOM_URL}/user-rooms/${userId}`);
      const rawData = Array.isArray(res.data) ? res.data : [];
      const fetched = rawData.map(normalizeRoom).filter(Boolean);
      setRoomList((prev) => dedupeById([...fetched, ...prev]));
      // Initialize unread counts from API response
      setUnreadCounts((prev) => {
        const updated = { ...prev };
        rawData.forEach((item) => {
          const id = getId(item);
          if (id && typeof item.unreadCount === 'number') {
            updated[id] = item.unreadCount;
          }
        });
        return updated;
      });
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
    if (isMobile) setMobilePane('chat');
    await loadRoomDetails(room.id);

    // Clean URL after successful invite join
    if (window.location.pathname.includes('/join/') || window.location.search.includes('invite=')) {
      window.history.replaceState({}, '', '/');
    }
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
        const roomId = getId(msg.room);
        if (currentActive?.type === 'room' && sameId(roomId, currentActive.id)) {
          setMessages((prev) => addOrReplaceMessage(prev, msg));
        } else {
          // Increment unread count for non-active room
          const senderId = getId(msg.sender);
          if (!sameId(senderId, currentUserId)) {
            setUnreadCounts((prev) => ({ ...prev, [roomId]: (prev[roomId] || 0) + 1 }));
          }
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
      } else {
        // Increment unread count for non-active DM chat
        if (!sameId(senderId, currentUserId)) {
          setUnreadCounts((prev) => ({ ...prev, [senderId]: (prev[senderId] || 0) + 1 }));
        }
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

    socket.on('message_deleted', ({ messageId }) => {
      if (!messageId) return;
      setMessages((prev) => prev.filter((m) => getId(m) !== messageId));
    });

    socket.on('read_confirmation', ({ messageIds, readBy }) => {
      if (!Array.isArray(messageIds) || !messageIds.length) return;
      setMessages((prev) =>
        prev.map((m) =>
          messageIds.includes(getId(m)) ? { ...m, isRead: true } : m
        )
      );
    });

    socket.on('chat_deleted_notification', (data) => {
      if (!data || !data.deletedById || !data.deletedByNickname) return;
      setChatDeleteNotification({
        deletedById: data.deletedById,
        deletedByNickname: data.deletedByNickname,
      });
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
    setNewAvatar(normalizedUser.avatar || '');
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
        // ignore
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
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
      // Req 19.4: Token muddati o'tgan yoki noto'g'ri bo'lsa, sessiyani tiklamaslik
      if (!isTokenValid(savedToken)) {
        clearSession();
        return;
      }

      // Req 19.2: Token haqiqiy bo'lsa, sessiyani tiklash
      const normalizedUser = normalizeUser(savedUser);
      setUser(normalizedUser);
      setToken(savedToken);
      setNewNickname(normalizedUser.nickname || '');
      setNewEmail(normalizedUser.email || '');
      setNewAvatar(normalizedUser.avatar || '');
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
      if (!isMobile && e.clientX >= 240 && e.clientX <= 520) {
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
  }, [isMobile]);

  useEffect(() => {
    if (!activeItem || !user) {
      setRoomDetails(null);
      return;
    }

    // Reset unread count for the newly active chat/room
    setUnreadCounts((prev) => {
      const id = activeItem.id;
      if (prev[id] && prev[id] > 0) {
        return { ...prev, [id]: 0 };
      }
      return prev;
    });

    const loadMessages = async () => {
      try {
        if (activeItem.type === 'user') {
          const res = await axios.get(`${API_URL}/messages/${user.id}/${activeItem.id}`);
          setMessages(Array.isArray(res.data) ? res.data.map(normalizeMessage) : []);
          // Mark DM messages as read
          if (socketRef.current) {
            socketRef.current.emit('mark_as_read', {
              chatPartnerId: activeItem.id,
              userId: user.id,
            });
          }
        } else if (activeItem.type === 'room') {
          if (socketRef.current) {
            socketRef.current.emit('join_room', activeItem.id);
          }
          const res = await axios.get(`${ROOM_URL}/messages/${activeItem.id}`);
          setMessages(Array.isArray(res.data) ? res.data.map(normalizeMessage) : []);
          await loadRoomDetails(activeItem.id);
          // Mark room messages as read
          if (socketRef.current) {
            socketRef.current.emit('mark_as_read', {
              roomId: activeItem.id,
              userId: user.id,
            });
          }
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
    }, 12000);
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
        newAvatar,
      });

      const updatedUser = normalizeUser(res.data.user);
      setUser(updatedUser);
      userRef.current = updatedUser;
      localStorage.setItem(STORAGE.user, JSON.stringify(updatedUser));
      setNewAvatar(updatedUser.avatar || '');
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
      if (isMobile) setMobilePane('chat');

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
      if (isMobile) setMobilePane('chat');

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
      if (isMobile) setMobilePane('chat');
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
      if (isMobile) setMobilePane('chat');
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

      // Always remove from local state after successful leave
      removeRoomFromLocalState(activeItem.id);

      setActiveItem(null);
      setMessages([]);
      setShowRoomInfo(false);
      if (isMobile) setMobilePane('sidebar');
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

    if (activeItem.type === 'room') {
      payload.room = activeItem.id;
    } else {
      payload.receiver = activeItem.id;
    }

    socketRef.current.emit('send_message', payload, (ack) => {
      if (ack && ack.ok === false) {
        // Req 21.7: Xatolik bo'lganda alert ko'rsatish va matnni saqlash
        alert(ack.message || 'Xabar jo\'natishda xatolik yuz berdi');
        return;
      }
      // Muvaffaqiyatli jo'natilganda tozalash
      setMessageText('');
      setReplyToMessage(null);
      setSelectedMedia(null);
      setMediaInputKey((prev) => prev + 1);
    });
  };

  const handleDeleteChat = async () => {
    if (!user || !activeItem || activeItem.type !== 'user') return;

    try {
      await axios.delete(`${API_URL}/chats/${user.id}/${activeItem.id}`);
      // Notify the other user about chat deletion
      if (socketRef.current) {
        socketRef.current.emit('notify_chat_deleted', { deletedBy: user.id, chatPartnerId: activeItem.id });
      }
      setChatList((prev) => prev.filter((u) => u.id !== activeItem.id));
      setActiveItem(null);
      setMessages([]);
      localStorage.removeItem(STORAGE.activeItem);
      if (isMobile) setMobilePane('sidebar');
    } catch (err) {
      alert(err.response?.data?.message || 'Xatolik');
    }
  };

  const handleAcceptDeleteChat = async () => {
    if (!user || !chatDeleteNotification) return;
    try {
      await axios.delete(`${API_URL}/chats/${user.id}/${chatDeleteNotification.deletedById}`);
      setChatList((prev) => prev.filter((u) => u.id !== chatDeleteNotification.deletedById));
      if (activeItem && sameId(activeItem.id, chatDeleteNotification.deletedById)) {
        setActiveItem(null);
        setMessages([]);
        localStorage.removeItem(STORAGE.activeItem);
        if (isMobile) setMobilePane('sidebar');
      }
      setChatDeleteNotification(null);
    } catch (err) {
      alert(err.response?.data?.message || 'Xatolik');
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
      if (isMobile) setMobilePane('sidebar');
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
      setCopiedInvite(true);
      setTimeout(() => setCopiedInvite(false), 2000);
    } catch {
      // Fallback: prompt bilan ko'rsatish
      window.prompt('Invite link:', text);
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
    setUnreadCounts({});
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
    setNewAvatar('');
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
    setShowForwardModal(false);
    setMessageToForward(null);
    setForwardSearchQuery('');
    setJoinInviteCode('');
    setSelectedMedia(null);
    setMediaInputKey((prev) => prev + 1);
    if (isMobile) setMobilePane('sidebar');
  };

  const handleMediaChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Hozir faqat rasm yuborish mumkin');
      return;
    }

    // Req 21.2: Rasm hajmi 10 MB dan oshmasligi kerak
    const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
    if (file.size > MAX_SIZE) {
      alert('Rasm hajmi 10 MB dan oshmasligi kerak');
      setMediaInputKey((prev) => prev + 1);
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

  const handleAvatarChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert(t('avatar_too_large'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setNewAvatar(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleForwardToDestination = (destination) => {
    if (!messageToForward || !user?.id || !socketRef.current) return;

    const payload = {
      sender: user.id,
      messageText: messageToForward.messageText || '',
      forwardedFrom: messageToForward.id,
    };

    if (messageToForward.mediaUrl) {
      payload.mediaUrl = messageToForward.mediaUrl;
      payload.mediaType = messageToForward.mediaType || '';
      payload.mediaName = messageToForward.mediaName || '';
    }

    if (destination.type === 'room') {
      payload.room = destination.id;
    } else {
      payload.receiver = destination.id;
    }

    socketRef.current.emit('send_message', payload, (ack) => {
      if (ack && ack.ok === false) {
        alert(ack.message || 'Xabar yo\'naltirishda xatolik yuz berdi');
        return;
      }
      setShowForwardModal(false);
      setMessageToForward(null);
      setForwardSearchQuery('');
      alert(t('forward_success'));
    });
  };

  const currentRole = roomDetails ? getRoomRole(roomDetails, user?.id) : null;
  const isOwner = currentRole === 'owner';
  const isAdmin = currentRole === 'admin' || currentRole === 'owner';
  const canAddPeople = isAdmin;
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

  const sidebarStyle = isMobile
    ? { width: '100%', minWidth: '100%' }
    : { width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` };

  if (!user) {
    return (
      <div className="auth-page">
        <style>{`
  :root {
    --bg:#0b141a;
    --panel:#111b21;
    --border:#2a3942;
    --muted:#8696a0;
    --accent:#00a884;
    --text:#e9edef;
  }

  * {
    box-sizing:border-box;
  }

  html, body, #root {
    width:100%;
    height:100%;
  }

  body {
    margin:0;
    background:var(--bg);
    color:var(--text);
    font-family:Inter, Arial, sans-serif;
    overflow:hidden;
  }

  .auth-page {
    width:100vw;
    height:100vh;
    background:
      radial-gradient(circle at top, rgba(0,168,132,.12), transparent 40%),
      var(--bg);
  }

  .auth-wrapper {
    width:100%;
    height:100%;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:20px;
  }

  .auth-container {
    width:min(460px, 100%);
    background:var(--panel);
    border:1px solid rgba(255,255,255,.05);
    border-radius:24px;
    padding:32px;
    box-shadow:0 20px 60px rgba(0,0,0,.35);
  }

  .auth-logo {
    display:flex;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    margin-bottom:24px;
    text-align:center;
  }

  .auth-logo img {
    width:72px;
    height:72px;
    object-fit:contain;
    margin-bottom:12px;
  }

  .auth-logo h1 {
    margin:0;
    font-size:42px;
    color:var(--accent);
    font-weight:800;
  }

  .auth-logo p {
    margin-top:8px;
    color:var(--muted);
  }

  .auth-container h2,
  .auth-container h3 {
    margin-top:0;
  }

  .auth-container input,
  .auth-container select,
  .auth-container textarea {
    width:100%;
    padding:14px 16px;
    background:#2a3942;
    border:1px solid #3c4b55;
    color:var(--text);
    border-radius:14px;
    outline:none;
    margin:8px 0 14px;
    font-size:15px;
  }

  .auth-container input:focus,
  .auth-container textarea:focus {
    border-color:var(--accent);
  }

  .auth-container textarea {
    min-height:90px;
    resize:vertical;
  }

  .auth-container button,
  .primary-btn {
    width:100%;
    background:var(--accent);
    color:white;
    border:none;
    border-radius:14px;
    padding:14px;
    cursor:pointer;
    font-weight:700;
    font-size:15px;
    transition:.2s;
  }

  .auth-container button:hover,
  .primary-btn:hover {
    opacity:.92;
  }

  .ghost-btn {
    background:#2a3942;
    color:white;
    border:none;
    border-radius:12px;
    padding:10px 12px;
    cursor:pointer;
  }

  .danger-btn {
    background:#ef4444;
    color:white;
    border:none;
    border-radius:12px;
    padding:10px 12px;
    cursor:pointer;
  }

  .lang-row {
    display:flex;
    justify-content:center;
    gap:14px;
    margin-bottom:24px;
  }

  .lang-chip {
    cursor:pointer;
    font-weight:700;
    color:var(--muted);
    transition:.2s;
  }

  .lang-chip.active {
    color:var(--accent);
  }

  .ghost-btn.active-lang {
    background:var(--accent);
    color:#fff;
    font-weight:700;
  }

  @media (max-width:600px) {
    .auth-container {
      padding:24px;
      border-radius:18px;
    }

    .auth-logo h1 {
      font-size:34px;
    }

    .auth-logo img {
      width:60px;
      height:60px;
    }
  }
`}</style>

        <div className="auth-wrapper">
          <div className="auth-container">
            <div className="lang-row">
              <span className={`lang-chip ${i18n.language === 'uz' ? 'active' : ''}`} onClick={() => changeLang('uz')}>UZ</span>
              <span className={`lang-chip ${i18n.language === 'ru' ? 'active' : ''}`} onClick={() => changeLang('ru')}>RU</span>
              <span className={`lang-chip ${i18n.language === 'en' ? 'active' : ''}`} onClick={() => changeLang('en')}>EN</span>
            </div>

            <div style={{ textAlign: 'center', marginBottom: '25px' }}>
              <h1 style={{ margin: 0, fontSize: '34px', color: '#00a884', fontWeight: 800 }}>
                OnlineAloqa
              </h1>
              <p style={{ marginTop: '8px', color: '#8696a0', fontSize: '14px' }}>
                Real-time Chat Platform
              </p>
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
  :root {
    --bg:#0b141a;
    --panel:#111b21;
    --border:#2a3942;
    --muted:#8696a0;
    --accent:#00a884;
    --text:#e9edef;
  }

  * {
    box-sizing: border-box;
  }

  html, body, #root {
    width: 100%;
    height: 100%;
  }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: Inter, Arial, sans-serif;
    overflow: hidden;
  }

  .chat-layout {
    display: flex;
    width: 100vw;
    height: 100vh;
    background: var(--bg);
    overflow: hidden;
  }

  .sidebar {
  height: 100vh;
  width: 340px;
  min-width: 300px;
  max-width: 420px;
  background: #111b21;
  border-right: 1px solid #2a3942;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex-shrink: 0;
}

.sidebar-inner {
  padding: 16px;
  overflow-y: auto;
  overflow-x: hidden;
  height: 100%;
}

.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  margin-bottom: 16px;
  border-bottom: 1px solid #2a3942;
}

.sidebar-brand img {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  object-fit: cover;
  flex-shrink: 0;
}

.sidebar-brand-title {
  font-size: 20px;
  font-weight: 800;
  line-height: 1.1;
}

.sidebar-brand-subtitle {
  font-size: 12px;
  color: #8696a0;
  margin-top: 2px;
}

.sidebar-greeting {
  font-size: 22px;
  font-weight: 800;
  margin: 6px 0 16px;
}

.sidebar-actions {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.sidebar-card {
  background: #17232c;
  border: 1px solid #2a3942;
  border-radius: 16px;
  padding: 14px;
  margin-bottom: 14px;
}

.sidebar-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #8696a0;
  font-weight: 700;
}

.sidebar-input {
  width: 100%;
  padding: 12px 14px;
  background: #2a3942;
  border: 1px solid #3c4b55;
  color: #e9edef;
  border-radius: 12px;
  outline: none;
  font-size: 14px;
}

.sidebar-input:focus {
  border-color: #00a884;
}

.sidebar-btn {
  width: 100%;
  background: #00a884;
  color: white;
  border: none;
  border-radius: 12px;
  padding: 12px 14px;
  font-weight: 700;
  cursor: pointer;
  margin-top: 10px;
}

.sidebar-btn.secondary {
  background: #2a3942;
}

.sidebar-section-title {
  font-size: 12px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #8696a0;
  font-weight: 700;
  margin: 18px 0 10px;
}

.room-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 14px;
  cursor: pointer;
  transition: .15s ease;
  margin-bottom: 8px;
  text-align: left;
}

.room-item:hover {
  background: #17232c;
  border-color: #2a3942;
}

.room-item.active {
  background: #1f2c35;
  border-color: #00a884;
}

.room-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: #2a3942;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #81a1c1;
  font-weight: 800;
}

.room-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.room-name {
  font-size: 15px;
  font-weight: 700;
  color: #e9edef;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.room-meta {
  font-size: 12px;
  color: #8696a0;
  margin-top: 2px;
}
  .resizer {
    width: 6px;
    cursor: col-resize;
    background: transparent;
    flex-shrink: 0;
  }

  .resizer:hover {
    background: rgba(255,255,255,.06);
  }

  .chat-area {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #0b141a;
    overflow: hidden;
  }

  .chat-header {
    min-height: 64px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 20px;
    border-bottom: 1px solid var(--border);
    background: rgba(17,27,33,.82);
    backdrop-filter: blur(10px);
    font-weight: 700;
    gap: 12px;
    flex-wrap: wrap;
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .message {
    max-width: min(72%, 720px);
    padding: 10px 14px;
    border-radius: 14px;
    line-height: 1.4;
    word-break: break-word;
    white-space: pre-wrap;
    position: relative;
  }

  .message.sent {
    align-self: flex-end;
    background: #005c4b;
  }

  .message.received {
    align-self: flex-start;
    background: #202c33;
  }

  .message.highlighted {
    outline: 2px solid #00a884;
    box-shadow: 0 0 0 2px rgba(0, 168, 132, .25);
  }

  .message-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .msg-btn {
    border: none;
    background: #2a3942;
    color: #e9edef;
    border-radius: 10px;
    padding: 6px 8px;
    cursor: pointer;
    font-size: 12px;
  }

  .input-area {
    display: flex;
    gap: 10px;
    padding: 16px;
    border-top: 1px solid var(--border);
    background: rgba(17,27,33,.95);
    align-items: center;
    flex-wrap: wrap;
  }

  .input-area input[type="text"] {
    flex: 1;
    min-width: 220px;
    width: 100%;
    padding: 12px 14px;
    background: #2a3942;
    border: 1px solid #3c4b55;
    color: var(--text);
    border-radius: 12px;
    outline: none;
  }

  .primary-btn {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 12px;
    padding: 12px 14px;
    cursor: pointer;
    font-weight: 700;
  }

  .ghost-btn {
    background: #2a3942;
    color: white;
    border: none;
    border-radius: 12px;
    padding: 10px 12px;
    cursor: pointer;
  }

  .danger-btn {
    background: #ef4444;
    color: white;
    border: none;
    border-radius: 12px;
    padding: 10px 12px;
    cursor: pointer;
  }

  .chip {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    border-radius: 12px;
    cursor: pointer;
    margin-bottom: 6px;
  }

  .chip.active {
    background: #2a3942;
  }

  .muted {
    color: var(--muted);
  }

  .section-title {
    font-size: 12px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--muted);
    margin: 18px 0 8px;
  }

  .stack {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .list-scroll {
    max-height: calc(100vh - 220px);
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
  }

  .field {
    width: 100%;
    margin-bottom: 14px;
  }

  .field label {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--muted);
  }

  .field input,
  .field textarea,
  .field select {
    width: 100%;
    padding: 12px 14px;
    background: #2a3942;
    border: 1px solid #3c4b55;
    color: var(--text);
    border-radius: 12px;
    outline: none;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.72);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 16px;
  }

  .modal-card {
    width: min(760px, 100%);
    max-height: calc(100vh - 32px);
    overflow: auto;
    background: var(--panel);
    border-radius: 20px;
    padding: 22px;
    border: 1px solid rgba(255,255,255,.04);
    box-shadow: 0 20px 60px rgba(0,0,0,.35);
  }

  .modal-card input,
  .modal-card select,
  .modal-card textarea {
    width: 100%;
    padding: 12px 14px;
    background: #2a3942;
    border: 1px solid #3c4b55;
    color: var(--text);
    border-radius: 12px;
    outline: none;
    margin: 8px 0 14px;
  }

  .modal-card textarea {
    min-height: 92px;
    resize: vertical;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 4px 8px;
    border-radius: 999px;
    font-size: 12px;
    background: #2a3942;
    color: #e9edef;
    margin-left: 8px;
  }

  .small {
    font-size: 12px;
    color: var(--muted);
  }

  .reply-box {
    padding: 10px 12px;
    background: #17232c;
    border: 1px solid #2a3942;
    border-radius: 12px;
    margin: 0 16px 10px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
  }

  .emoji-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 8px;
  }

  .media-preview {
    width: 100%;
    max-width: 220px;
    border-radius: 12px;
    display: block;
    margin-top: 8px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 15px;
    padding-bottom: 15px;
    border-bottom: 1px solid var(--border);
  }

  .brand img {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .desktop-only {
    display: block;
  }

  .mobile-back {
    display: none;
  }

  .hide-mobile {
    display: block;
  }

  @media (max-width: 900px) {
    .chat-layout {
      flex-direction: column;
    }

    .sidebar {
      width: 100% !important;
      min-width: 100% !important;
      max-width: 100%;
      height: auto;
      border-right: none;
      border-bottom: 1px solid var(--border);
    }

    .chat-area {
      width: 100%;
      height: calc(100vh - 280px);
    }

    .chat-header {
      padding: 12px 14px;
    }

    .messages-container {
      padding: 12px;
    }

    .input-area {
      padding: 12px;
    }

    .input-area input[type="text"] {
      min-width: 100%;
      order: 2;
    }

    .input-area input[type="file"] {
      order: 1;
      max-width: 100% !important;
      width: 100%;
    }

    .input-area button[type="submit"] {
      order: 3;
      width: 100%;
    }

    .stack {
      flex-direction: column;
    }

    .stack > button {
      width: 100%;
    }
  }

  @media (max-width: 600px) {
    .sidebar-inner,
    .messages-container {
      padding: 12px;
    }

    .chat-header {
      flex-direction: column;
      align-items: flex-start;
    }

    .modal-card {
      width: 100%;
    }
      }}
      `}</style>

{(!isMobile || mobilePane === 'sidebar') && (
  <div className="sidebar" style={sidebarStyle}>
    <div className="sidebar-inner">
    <div className="sidebar-brand">
  <img src="/logo.png" alt="OnlineAloqa" />
  <div>
    <div className="sidebar-brand-title">OnlineAloqa</div>
    <div className="sidebar-brand-subtitle">Real-time Chat Platform</div>
  </div>
</div>

      <div className="sidebar-greeting">
        {t('welcome')}, @{user.nickname}!
      </div>

      <div className="sidebar-actions">
        <button
          className="ghost-btn"
          onClick={() => {
            setShowSettings((prev) => !prev);
            setShowCreateModal(false);
            setShowRoomInfo(false);
            if (isMobile) setMobilePane('sidebar');
          }}
        >
          {showSettings ? t('back') : t('settings')}
        </button>
        <button className="danger-btn" onClick={handleLogout}>
          {t('logout')}
        </button>
      </div>
      
  {showSettings ? (
    <div className="sidebar-card">
      <form onSubmit={handleUpdateProfile}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' }}>
          {newAvatar ? (
            <img src={newAvatar} alt="avatar" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} />
          ) : (
            <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px' }}>
              {user.nickname?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
          <div>
            <input type="file" accept="image/*" onChange={handleAvatarChange} style={{ maxWidth: '160px' }} />
            {newAvatar && (
              <button type="button" className="ghost-btn" style={{ marginTop: '6px', fontSize: '12px' }} onClick={() => setNewAvatar('')}>
                {t('remove_avatar')}
              </button>
            )}
          </div>
        </div>

        <label className="sidebar-label">{t('username_label')}</label>
        <input
          className="sidebar-input"
          type="text"
          value={newNickname}
          onChange={(e) => setNewNickname(e.target.value)}
          placeholder={t('placeholder_nickname')}
        />
  
        <label className="sidebar-label">{t('email_label')}</label>
        <input
          className="sidebar-input"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder={t('placeholder_email')}
        />
  
        <label className="sidebar-label">{t('new_password_label')}</label>
        <input
          className="sidebar-input"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t('placeholder_new_password')}
        />
  
        <div className="sidebar-section-title">{t('select_lang')}</div>
        <div className="stack">
          <button type="button" className={`ghost-btn${i18n.language === 'uz' ? ' active-lang' : ''}`} onClick={() => changeLang('uz')}>🇺🇿 UZ</button>
          <button type="button" className={`ghost-btn${i18n.language === 'ru' ? ' active-lang' : ''}`} onClick={() => changeLang('ru')}>🇷🇺 RU</button>
          <button type="button" className={`ghost-btn${i18n.language === 'en' ? ' active-lang' : ''}`} onClick={() => changeLang('en')}>🇬🇧 EN</button>
        </div>
  
        <button type="submit" className="sidebar-btn" style={{ marginTop: '14px' }}>
          {t('save')}
        </button>
  
        <button
          type="button"
          className="sidebar-btn secondary"
          style={{ marginTop: '12px', background: '#ef4444' }}
          onClick={() => setShowDeleteAccountModal(true)}
        >
          Accountni o‘chirish
        </button>
      </form>
    </div>
  ) : (
    <div className="list-scroll">
    <button
      onClick={() => {
        setShowCreateModal(true);
        setShowSettings(false);
        if (isMobile) setMobilePane('sidebar');
      }}
      className="ghost-btn"
      style={{
        width: '100%',
        textAlign: 'left',
        marginBottom: '15px',
        fontWeight: 700,
        padding: '12px 14px',
        borderRadius: '14px'
      }}
    >
      ➕ {t('create_room')}
    </button>
  
    <div
      style={{
        background: '#17232c',
        border: '1px solid #2a3942',
        borderRadius: '16px',
        padding: '14px',
        marginBottom: '14px'
      }}
    >
      <div className="section-title" style={{ marginTop: 0 }}>
        {t('search_user')}
      </div>
      <input
        type="text"
        placeholder={t('placeholder_nickname')}
        value={searchNickname}
        onChange={(e) => setSearchNickname(e.target.value)}
        style={{
          width: '100%',
          padding: '12px 14px',
          background: '#2a3942',
          border: '1px solid #3c4b55',
          color: '#e9edef',
          borderRadius: '12px',
          outline: 'none'
        }}
      />
      <button
        onClick={handleSearchUser}
        className="primary-btn"
        style={{ width: '100%', marginTop: '10px' }}
      >
        {t('start_chat')}
      </button>
    </div>
  
    <div
      style={{
        background: '#17232c',
        border: '1px solid #2a3942',
        borderRadius: '16px',
        padding: '14px',
        marginBottom: '14px'
      }}
    >
      <div className="section-title" style={{ marginTop: 0 }}>
        {t('room_username')} {t('search')}
      </div>
      <input
        type="text"
        placeholder={t('room_username')}
        value={searchRoomUsername}
        onChange={(e) => setSearchRoomUsername(e.target.value)}
        style={{
          width: '100%',
          padding: '12px 14px',
          background: '#2a3942',
          border: '1px solid #3c4b55',
          color: '#e9edef',
          borderRadius: '12px',
          outline: 'none'
        }}
      />
      <button
        onClick={handleSearchRoomByUsername}
        className="primary-btn"
        style={{ width: '100%', marginTop: '10px' }}
      >
        {t('search')}
      </button>
    </div>
  
    <div
      style={{
        background: '#17232c',
        border: '1px solid #2a3942',
        borderRadius: '16px',
        padding: '14px',
        marginBottom: '14px'
      }}
    >
      <div className="section-title" style={{ marginTop: 0 }}>
        {t('join_room')} / Invite
      </div>
      <input
        type="text"
        placeholder="invite code"
        value={joinInviteCode}
        onChange={(e) => setJoinInviteCode(e.target.value)}
        style={{
          width: '100%',
          padding: '12px 14px',
          background: '#2a3942',
          border: '1px solid #3c4b55',
          color: '#e9edef',
          borderRadius: '12px',
          outline: 'none'
        }}
      />
      <button
        onClick={handleJoinByInviteCode}
        className="ghost-btn"
        style={{ width: '100%', marginTop: '10px' }}
      >
        {t('join_room')}
      </button>
    </div>
  
    {roomList.length > 0 && (
      <h4 className="section-title">{t('channels_groups')}</h4>
    )}
  
    {roomList.map((room) => {
      const memberCount = Array.isArray(room.members) ? room.members.length : 0;
      const active = activeItem?.type === 'room' && sameId(activeItem.id, room.id);
      const unread = unreadCounts[room.id] || 0;
  
      return (
        <div
          key={room.id}
          onClick={() => {
            setShowSettings(false);
            setShowCreateModal(false);
            setActiveItem({
              type: 'room',
              id: room.id,
              label: room.name,
              roomType: room.type,
              creator: room.owner,
            });
            setShowRoomInfo(false);
            if (isMobile) setMobilePane('chat');
            loadRoomDetails(room.id);
          }}
          className={`chip ${active ? 'active' : ''}`}
          style={{
            background: active ? '#1f2c35' : 'transparent',
            border: active ? '1px solid #00a884' : '1px solid transparent',
            marginBottom: '8px'
          }}
        >
          <span style={{ color: '#81a1c1' }}>
            {room.type === 'channel' ? '#' : '👥'}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span>{room.name}</span>
            <span className="small">{memberCount} {t('members')}</span>
          </span>
          {unread > 0 && (
            <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>
          )}
        </div>
      );
    })}

    {chatList.length > 0 && (
      <h4 className="section-title">{t('chats') || 'Chatlar'}</h4>
    )}

    {chatList.map((chatUser) => {
      const active = activeItem?.type === 'user' && sameId(activeItem.id, chatUser.id);
      const unread = unreadCounts[chatUser.id] || 0;

      return (
        <div
          key={chatUser.id}
          onClick={() => {
            setShowSettings(false);
            setShowCreateModal(false);
            setActiveItem({
              type: 'user',
              id: chatUser.id,
              label: chatUser.nickname,
            });
            setShowRoomInfo(false);
            if (isMobile) setMobilePane('chat');
          }}
          className={`chip ${active ? 'active' : ''}`}
          style={{
            background: active ? '#1f2c35' : 'transparent',
            border: active ? '1px solid #00a884' : '1px solid transparent',
            marginBottom: '8px'
          }}
        >
          {chatUser.avatar ? (
            <img src={chatUser.avatar} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
          ) : (
            <span style={{ width: 36, height: 36, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '14px' }}>
              {chatUser.nickname?.charAt(0)?.toUpperCase() || '?'}
            </span>
          )}
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span>@{chatUser.nickname}</span>
          </span>
          {unread > 0 && (
            <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>
          )}
        </div>
      );
    })}
  </div>
            )}
          </div>
        </div>
      )}

      {!isMobile && <div className="resizer desktop-only" onMouseDown={() => { isResizing.current = true; document.body.style.cursor = 'col-resize'; }} />}

      {(!isMobile || mobilePane === 'chat') && (
        <div className="chat-area">
          {activeItem ? (
            <>
              <div className="chat-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  {isMobile && (
                    <button
                      className="ghost-btn mobile-back"
                      type="button"
                      onClick={() => setMobilePane('sidebar')}
                    >
                      ←
                    </button>
                  )}
                  {activeItem.type === 'user' && (() => {
                    const partner = chatList.find((u) => sameId(u.id, activeItem.id));
                    return partner?.avatar ? (
                      <img src={partner.avatar} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                    ) : (
                      <span style={{ width: 32, height: 32, borderRadius: '50%', background: '#2a3942', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '13px' }}>
                        {activeItem.label?.charAt(0)?.toUpperCase() || '?'}
                      </span>
                    );
                  })()}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeHeaderText}
                  </span>
                </div>

                <div className="stack" onClick={(e) => e.stopPropagation()}>
                  {activeItem.type === 'room' && (
                    <button
                      className="ghost-btn"
                      type="button"
                      onClick={() => {
                        setShowRoomInfo(true);
                        if (isMobile) setMobilePane('chat');
                        loadRoomDetails(activeItem.id);
                      }}
                    >
                      {t('members')}
                    </button>
                  )}

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

              {chatDeleteNotification && activeItem?.type === 'user' && sameId(activeItem.id, chatDeleteNotification.deletedById) && (
                <div style={{ padding: '12px 16px', background: '#1f2c35', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <span>{t('chat_deleted_by', { name: chatDeleteNotification.deletedByNickname })}</span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="danger-btn" onClick={handleAcceptDeleteChat}>{t('yes_delete')}</button>
                    <button className="ghost-btn" onClick={() => setChatDeleteNotification(null)}>{t('no_keep')}</button>
                  </div>
                </div>
              )}

              {replyToMessage && (
                <div className="reply-box">
                  <div style={{ overflow: 'hidden', flex: 1 }}>
                    <div className="small" style={{ color: 'var(--accent)', fontWeight: 600 }}>{t('replying_to')}</div>
                    <div style={{ fontWeight: 700, fontSize: '13px' }}>
                      {replyToMessage.sender?.nickname ? `@${replyToMessage.sender.nickname}` : '@unknown'}
                    </div>
                    <div style={{ fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', opacity: 0.85 }}>
                      {replyToMessage.deletedForAll ? '[deleted]' : (replyToMessage.messageText || replyToMessage.mediaName || '').slice(0, 80) + ((replyToMessage.messageText || '').length > 80 ? '…' : '')}
                    </div>
                  </div>
                  <button className="ghost-btn" type="button" onClick={() => setReplyToMessage(null)} style={{ fontSize: '18px', padding: '4px 10px', lineHeight: 1 }} aria-label={t('cancel')}>
                    ✕
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
                    <div className="small" style={{ marginBottom: '6px' }}>{t('pinned_messages')}</div>
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
                          {t('forwarded_from')}{' '}
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
                        <button className="msg-btn" type="button" onClick={() => setReplyToMessage(msg)}>{t('reply')}</button>
                        <button className="msg-btn" type="button" onClick={() => { setMessageToForward(msg); setShowForwardModal(true); setForwardSearchQuery(''); }}>{t('forward')}</button>

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
                            {t('pin_message')}
                          </button>
                        )}

                        {activeItem.type === 'room' && isAdmin && roomPinned && (
                          <button
                            className="msg-btn"
                            type="button"
                            onClick={() => axios.delete(`${ROOM_URL}/${activeItem.id}/pin/${msg.id}`, { data: { userId: user.id } }).then(() => loadRoomDetails(activeItem.id))}
                          >
                            {t('unpin_message')}
                          </button>
                        )}

                        {canDelete && (
                          <button className="msg-btn" type="button" onClick={() => handleDeleteMessageForAll(msg.id)}>
                            {t('delete_for_all')}
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
                  placeholder={
                    activeItem.type === 'room' && roomDetails?.type === 'channel' && !canWriteRoom(roomDetails, user.id)
                      ? 'Only admin can write here'
                      : '...'
                  }
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  disabled={activeItem.type === 'room' && roomDetails?.type === 'channel' && !canWriteRoom(roomDetails, user.id)}
                />
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={
                    (activeItem.type === 'room' && roomDetails?.type === 'channel' && !canWriteRoom(roomDetails, user.id)) ||
                    (!messageText.trim() && !selectedMedia)
                  }
                >
                  {t('send')}
                </button>
              </form>
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: '#8696a0', fontSize: '16px', padding: '20px', textAlign: 'center' }}>
              {t('empty_chat')}
            </div>
          )}
        </div>
      )}

      {showForwardModal && messageToForward && (
        <div className="modal-backdrop">
          <div className="modal-card" style={{ width: 'min(400px, 100%)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0 }}>{t('forward_to')}</h3>
              <span
                onClick={() => { setShowForwardModal(false); setMessageToForward(null); setForwardSearchQuery(''); }}
                style={{ cursor: 'pointer', fontSize: '24px', color: '#8696a0' }}
              >
                &times;
              </span>
            </div>

            <div style={{ padding: '8px 0', marginBottom: '8px', background: '#17232c', borderRadius: '10px', padding: '10px' }}>
              <div className="small" style={{ marginBottom: '4px', color: 'var(--accent)' }}>{t('forward_draft')}:</div>
              <div style={{ fontSize: '13px', opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {messageToForward.deletedForAll ? '[deleted]' : (messageToForward.messageText || messageToForward.mediaName || '').slice(0, 100)}
              </div>
            </div>

            <input
              type="text"
              placeholder={t('search') + '...'}
              value={forwardSearchQuery}
              onChange={(e) => setForwardSearchQuery(e.target.value)}
              style={{ marginBottom: '12px' }}
            />

            <div style={{ flex: 1, overflowY: 'auto', maxHeight: '400px' }}>
              {chatList.length > 0 && (
                <>
                  <div className="section-title" style={{ marginTop: 0 }}>{t('direct_messages')}</div>
                  {chatList
                    .filter((u) => !sameId(u.id, user.id) && (!forwardSearchQuery || normalizeText(u.nickname).includes(normalizeText(forwardSearchQuery))))
                    .map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        className="room-item"
                        onClick={() => handleForwardToDestination({ type: 'user', id: u.id, label: u.nickname })}
                      >
                        <div className="room-icon">@</div>
                        <div className="room-text">
                          <div className="room-name">{u.nickname}</div>
                          <div className="room-meta">DM</div>
                        </div>
                      </button>
                    ))}
                </>
              )}

              {roomList.length > 0 && (
                <>
                  <div className="section-title">{t('channels_groups')}</div>
                  {roomList
                    .filter((r) => !forwardSearchQuery || normalizeText(r.name).includes(normalizeText(forwardSearchQuery)))
                    .map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className="room-item"
                        onClick={() => handleForwardToDestination({ type: 'room', id: r.id, label: r.name, roomType: r.type })}
                      >
                        <div className="room-icon">{r.type === 'channel' ? '#' : '👥'}</div>
                        <div className="room-text">
                          <div className="room-name">{r.name}</div>
                          <div className="room-meta">{r.type === 'channel' ? t('channel') : t('group')}</div>
                        </div>
                      </button>
                    ))}
                </>
              )}

              {chatList.filter((u) => !sameId(u.id, user.id) && (!forwardSearchQuery || normalizeText(u.nickname).includes(normalizeText(forwardSearchQuery)))).length === 0 &&
               roomList.filter((r) => !forwardSearchQuery || normalizeText(r.name).includes(normalizeText(forwardSearchQuery))).length === 0 && (
                <div style={{ textAlign: 'center', color: '#8696a0', padding: '20px' }}>
                  {t('no_results')}
                </div>
              )}
            </div>

            <button
              type="button"
              className="ghost-btn"
              style={{ width: '100%', marginTop: '12px' }}
              onClick={() => { setShowForwardModal(false); setMessageToForward(null); setForwardSearchQuery(''); }}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', gap: '10px' }}>
              <h3 style={{ margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                {copiedInvite ? '✓ Copied!' : t('copy_link')}
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
                {copiedInvite ? '✓ Copied!' : t('copy_link')}
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

            {canAddPeople && (
            <div style={{ marginBottom: '18px' }}>
              <h4 className="section-title" style={{ marginTop: 0 }}>{t('add_member')}</h4>
              <input
                type="text"
                placeholder={t('search')}
                value={memberNickname}
                onChange={(e) => setMemberNickname(e.target.value)}
              />
              <button type="button" className="primary-btn" style={{ width: '100%' }} onClick={handleFindMember}>
                {t('search')}
              </button>

              {memberSearchResult && (
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
            )}

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

                      {isOwner && !isCreator && !isCurrentUser && (
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

                      {!isOwner && isAdmin && !isCreator && !isMemberAdmin && !isCurrentUser && (
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
