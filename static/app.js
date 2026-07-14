// Initialize variables
let activeSessionId = null;
let telegramUser = null;
let initDataRaw = null;
let authPollInterval = null;
let currentMessageCount = 0;
let currentMessageLimit = 50;

// DOM Elements
const loadingOverlay = document.getElementById("loading-overlay");
const loginContainer = document.getElementById("login-container");
const appContainer = document.getElementById("app-container");
const tgLoginBtn = document.getElementById("tg-login-btn");
const desktopLoginStatus = document.getElementById("desktop-login-status");

const sidebar = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const newChatBtn = document.getElementById("new-chat-btn");
const historyItems = document.getElementById("history-items");
const activeChatTitle = document.getElementById("active-chat-title");

const chatMessagesContainer = document.getElementById("chat-messages-container");
const messagesList = document.getElementById("messages-list");
const welcomePrompt = document.getElementById("welcome-prompt");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const typingIndicator = document.getElementById("typing-indicator");
const messageCounter = document.getElementById("message-counter");
const limitBanner = document.getElementById("limit-reached-banner");
const limitNewChatBtn = document.getElementById("limit-new-chat-btn");

// Modals
const accountModal = document.getElementById("account-modal");
const accountBtn = document.getElementById("account-btn");
const memoryModal = document.getElementById("memory-modal");
const memoryBtn = document.getElementById("memory-btn");
const logoutBtn = document.getElementById("logout-btn");

// Init Telegram WebApp
const tg = window.Telegram ? window.Telegram.WebApp : null;

// On Load
document.addEventListener("DOMContentLoaded", () => {
    // Textarea autosize event
    chatInput.addEventListener("input", autoSizeTextarea);
    
    // Send message events
    sendBtn.addEventListener("click", sendMessage);
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Mobile Sidebar Toggle
    sidebarToggle.addEventListener("click", () => {
        sidebar.classList.toggle("open");
    });

    // New Chat Click
    newChatBtn.addEventListener("click", startNewChat);
    limitNewChatBtn.addEventListener("click", startNewChat);

    // Modal Triggers
    accountBtn.addEventListener("click", openAccountModal);
    memoryBtn.addEventListener("click", openMemoryModal);
    logoutBtn.addEventListener("click", logout);

    // Close modals
    document.querySelectorAll(".close-modal-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            accountModal.classList.add("hidden");
            memoryModal.classList.add("hidden");
        });
    });

    // Close modals on overlay click
    window.addEventListener("click", (e) => {
        if (e.target === accountModal) accountModal.classList.add("hidden");
        if (e.target === memoryModal) memoryModal.classList.add("hidden");
    });

    // Run Auth Check
    checkAuth();
});

// ── AUTHENTICATION FLOWS ──

async function checkAuth() {
    // Scenario 1: Inside Telegram Mini App
    if (tg && tg.initData) {
        initDataRaw = tg.initData;
        tg.expand(); // Make full-screen
        
        try {
            const resp = await fetch("/api/auth/initdata", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ initData: initDataRaw })
            });
            
            if (resp.ok) {
                const data = await resp.json();
                telegramUser = data.user;
                loginSuccess();
                return;
            }
        } catch (e) {
            console.error("WebApp auth error:", e);
        }
    }

    // Scenario 2: Standard browser (Session Cookie check)
    try {
        const resp = await fetch("/api/user/profile");
        if (resp.ok) {
            const data = await resp.json();
            telegramUser = data;
            loginSuccess();
            return;
        }
    } catch (e) {
        console.error("Profile check error:", e);
    }

    // Not authenticated -> Show Login screen
    loadingOverlay.classList.add("hidden");
    loginContainer.classList.remove("hidden");
}

// Browser Fallback: QR / Link Redirect Auth
tgLoginBtn.addEventListener("click", async () => {
    tgLoginBtn.disabled = true;
    desktopLoginStatus.classList.remove("hidden");

    try {
        const resp = await fetch("/api/auth/init", { method: "POST" });
        if (resp.ok) {
            const data = await resp.json();
            
            // Redirect to bot in a new tab
            window.open(data.bot_url, "_blank");

            // Start polling session status
            pollAuthStatus(data.session_id);
        }
    } catch (e) {
        console.error("Auth init failed:", e);
        tgLoginBtn.disabled = false;
        desktopLoginStatus.classList.add("hidden");
    }
});

function pollAuthStatus(sessionId) {
    if (authPollInterval) clearInterval(authPollInterval);

    authPollInterval = setInterval(async () => {
        try {
            const resp = await fetch(`/api/auth/status/${sessionId}`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.status === "authenticated") {
                    clearInterval(authPollInterval);
                    telegramUser = data.user;
                    loginSuccess();
                }
            } else {
                clearInterval(authPollInterval);
                tgLoginBtn.disabled = false;
                desktopLoginStatus.classList.add("hidden");
            }
        } catch (e) {
            console.error("Poll auth error:", e);
        }
    }, 2000);
}

function loginSuccess() {
    loginContainer.classList.add("hidden");
    appContainer.classList.remove("hidden");
    loadingOverlay.classList.add("hidden");
    
    // Set initials in sidebar
    const initials = telegramUser.first_name ? telegramUser.first_name.charAt(0).toUpperCase() : "U";
    document.getElementById("user-avatar-initials").innerText = initials;
    document.getElementById("profile-name").innerText = telegramUser.first_name || "User";
    
    // Load chat logs & stats
    initializeChatOnOpen();
    loadProfileStats();
}

// Every time the mini app / page is opened, we start a fresh chat
// (like opening a new tab in ChatGPT/Claude) while all previous chats
// remain accessible in the sidebar history.
async function initializeChatOnOpen() {
    await loadSessions({ autoSelect: false });
    await startNewChat();
}

async function logout() {
    if (confirm("Are you sure you want to log out?")) {
        await fetch("/api/auth/logout", { method: "POST" });
        location.reload();
    }
}

// ── SESSIONS MANAGEMENT ──

async function loadSessions({ autoSelect = false } = {}) {
    try {
        const resp = await fetch("/api/sessions");
        if (resp.ok) {
            const sessions = await resp.json();
            renderSessionsList(sessions);

            // Only used when explicitly asked (e.g. after deleting the active chat)
            if (autoSelect) {
                if (sessions.length > 0) {
                    selectSession(sessions[0].id, sessions[0].title);
                } else {
                    startNewChat();
                }
            }
        }
    } catch (e) {
        console.error("Load sessions failed:", e);
    }
}

function renderSessionsList(sessions) {
    historyItems.innerHTML = "";
    sessions.forEach(sess => {
        const item = document.createElement("div");
        item.className = `history-item ${sess.id === activeSessionId ? "active" : ""}`;
        item.dataset.id = sess.id;
        item.onclick = () => selectSession(sess.id, sess.title);

        const titleSpan = document.createElement("span");
        titleSpan.className = "history-title";
        titleSpan.innerText = sess.title;

        const actions = document.createElement("div");
        actions.className = "history-actions";

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-history-action";
        deleteBtn.innerHTML = "🗑️";
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteSession(sess.id);
        };

        actions.appendChild(deleteBtn);
        item.appendChild(titleSpan);
        item.appendChild(actions);
        historyItems.appendChild(item);
    });
}

async function startNewChat() {
    try {
        const resp = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "New Chat" })
        });
        if (resp.ok) {
            const data = await resp.json();
            activeSessionId = data.id;

            // Reload sidebar sessions list (without stealing focus from the new chat)
            await loadSessions({ autoSelect: false });
            selectSession(data.id, "New Chat");
            updateMessageCounter(0, currentMessageLimit);
        }
    } catch (e) {
        console.error("Create session failed:", e);
    }
}

async function selectSession(sessionId, title) {
    activeSessionId = sessionId;
    activeChatTitle.innerText = title;

    // Close mobile sidebar if open
    sidebar.classList.remove("open");

    // Update active highlight class
    document.querySelectorAll(".history-item").forEach(item => {
        if (item.dataset.id === sessionId) {
            item.classList.add("active");
        } else {
            item.classList.remove("active");
        }
    });

    // Fetch messages
    try {
        const resp = await fetch(`/api/chat/${sessionId}`);
        if (resp.ok) {
            const data = await resp.json();
            renderMessages(data.messages);
            updateMessageCounter(data.user_message_count, data.message_limit);
        }
    } catch (e) {
        console.error("Load chat history failed:", e);
    }
}

// ── MESSAGE LIMIT UI ──

function updateMessageCounter(count, limit) {
    currentMessageCount = count;
    currentMessageLimit = limit;

    messageCounter.innerText = `${count}/${limit}`;
    messageCounter.classList.remove("hidden");
    messageCounter.classList.toggle("near-limit", count >= limit - 5 && count < limit);
    messageCounter.classList.toggle("at-limit", count >= limit);

    const reached = count >= limit;
    limitBanner.classList.toggle("hidden", !reached);
    chatInput.disabled = reached;
    sendBtn.disabled = reached;
    chatInput.placeholder = reached
        ? "Message limit reached — start a new chat to keep going"
        : "Ask BRAINY anything...";
}

async function deleteSession(sessionId) {
    if (!confirm("Delete this chat?")) return;
    
    try {
        const resp = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
        if (resp.ok) {
            const wasActive = activeSessionId === sessionId;
            if (wasActive) {
                activeSessionId = null;
            }
            loadSessions({ autoSelect: wasActive });
        }
    } catch (e) {
        console.error("Delete session failed:", e);
    }
}

// ── MESSAGES VIEW & INTERACTION ──

function renderMessages(messages) {
    messagesList.innerHTML = "";
    
    if (messages.length === 0) {
        welcomePrompt.classList.remove("hidden");
        return;
    }
    
    welcomePrompt.classList.add("hidden");
    
    messages.forEach(msg => {
        appendMessageBubble(msg.role, msg.content);
    });
    
    scrollToBottom();
}

function appendMessageBubble(role, content) {
    const row = document.createElement("div");
    row.className = `message-row ${role}`;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (role === "assistant") {
        const avatar = document.createElement("div");
        avatar.className = "message-avatar";
        avatar.innerText = "🤖";
        row.appendChild(avatar);
        
        // Format response content (converting stashed codeblocks or HTML stashes)
        bubble.innerHTML = formatAIResponse(content);
    } else {
        bubble.innerText = content;
    }

    row.appendChild(bubble);
    messagesList.appendChild(row);
    
    // Run Prism highlighting on any newly inserted code blocks
    if (role === "assistant") {
        Prism.highlightAllUnder(bubble);
    }
}

function formatAIResponse(text) {
    if (!text) return "";
    
    // We already stashed code blocks inside app.py / study_bot.py as HTML elements:
    // <pre><code class="language-lang">...</code></pre>
    // We just need to add the copy buttons before rendering them.
    // Let's parse the HTML using temporary element to attach copy actions.
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = text;
    
    const codeBlocks = tempDiv.querySelectorAll("pre");
    codeBlocks.forEach(pre => {
        const codeElement = pre.querySelector("code");
        const lang = codeElement ? codeElement.className.replace("language-", "") : "code";
        
        // Create code container and headers
        const container = document.createElement("div");
        container.className = "code-container";
        
        const header = document.createElement("div");
        header.className = "code-header";
        
        const langSpan = document.createElement("span");
        langSpan.innerText = lang.toUpperCase();
        
        const copyBtn = document.createElement("button");
        copyBtn.className = "copy-btn";
        copyBtn.innerText = "Copy";
        copyBtn.onclick = () => copyCodeText(codeElement.innerText, copyBtn);
        
        header.appendChild(langSpan);
        header.appendChild(copyBtn);
        
        // Inject into the pre block
        pre.insertBefore(header, pre.firstChild);
    });
    
    return tempDiv.innerHTML;
}

function copyCodeText(text, button) {
    navigator.clipboard.writeText(text).then(() => {
        button.innerText = "Copied!";
        setTimeout(() => {
            button.innerText = "Copy";
        }, 2000);
    });
}

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || !activeSessionId || currentMessageCount >= currentMessageLimit) return;

    // Clear input & reset height
    chatInput.value = "";
    chatInput.style.height = "auto";

    // Hide suggestions
    welcomePrompt.classList.add("hidden");

    // Append user message bubble
    appendMessageBubble("user", text);
    scrollToBottom();

    // Show thinking indicator
    typingIndicator.classList.remove("hidden");
    scrollToBottom();

    try {
        const resp = await fetch("/api/chat/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: activeSessionId,
                content: text
            })
        });

        // Hide thinking indicator
        typingIndicator.classList.add("hidden");

        const data = await resp.json().catch(() => ({}));

        if (resp.ok) {
            appendMessageBubble("assistant", data.content);
            scrollToBottom();
            updateMessageCounter(data.user_message_count, data.message_limit);

            // If session title was updated, reload sidebar
            if (data.new_title) {
                loadSessions({ autoSelect: false });
            }
        } else if (resp.status === 403 && data.error === "limit_reached") {
            updateMessageCounter(data.user_message_count, data.message_limit);
            appendMessageBubble("assistant", `🔒 ${data.message}`);
            scrollToBottom();
        } else {
            appendMessageBubble("assistant", "❌ Failed to get response. Please try again.");
            scrollToBottom();
        }
    } catch (e) {
        typingIndicator.classList.add("hidden");
        appendMessageBubble("assistant", "❌ Network error. Check your connection.");
        scrollToBottom();
        console.error("Send message error:", e);
    }
}

// ── UTILITIES ──

function handleSuggestion(text) {
    chatInput.value = text;
    autoSizeTextarea();
    chatInput.focus();
}

function autoSizeTextarea() {
    chatInput.style.height = "auto";
    chatInput.style.height = (chatInput.scrollHeight) + "px";
}

function scrollToBottom() {
    chatMessagesContainer.scrollTop = chatMessagesContainer.scrollHeight;
}

// ── PROFILE STATS & MODALS ──

async function loadProfileStats() {
    try {
        const resp = await fetch("/api/user/profile");
        if (resp.ok) {
            const profile = await resp.json();
            document.getElementById("profile-level-badge").innerText = profile.level;
            
            // Populate Modal Profile Info
            document.getElementById("modal-name").innerText = profile.first_name;
            document.getElementById("modal-username").innerText = profile.username ? "@" + profile.username : "No Username";
            document.getElementById("modal-level").innerText = profile.level;
            document.getElementById("modal-total").innerText = profile.total;
            document.getElementById("modal-score").innerText = `${profile.score} correct`;
            document.getElementById("modal-joined").innerText = profile.joined;
        }
    } catch (e) {
        console.error("Load stats failed:", e);
    }
}

async function openAccountModal() {
    await loadProfileStats();
    accountModal.classList.remove("hidden");
}

async function openMemoryModal() {
    memoryModal.classList.remove("hidden");
    
    // Fetch user memory insights
    try {
        const resp = await fetch("/api/user/memory");
        if (resp.ok) {
            const memory = await resp.json();
            
            // Render learning context box
            document.getElementById("memory-learn-context").innerText = memory.learn_context;
            
            // Render liked notes
            const likedList = document.getElementById("memory-liked-notes");
            likedList.innerHTML = "";
            if (memory.liked_notes.length === 0) {
                likedList.innerHTML = "<li>No liked answer summaries saved yet. Tap 👍 on bot replies to add memory context!</li>";
            } else {
                memory.liked_notes.forEach(note => {
                    const li = document.createElement("li");
                    li.innerText = note;
                    likedList.appendChild(li);
                });
            }
        }
    } catch (e) {
        console.error("Load memory failed:", e);
    }
}
