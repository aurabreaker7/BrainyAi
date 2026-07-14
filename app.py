import os
import sqlite3
import uuid
import hmac
import hashlib
import json
import urllib.parse
import random
from flask import Flask, request, jsonify, render_template, redirect, session, send_from_directory

# Import AI functions from study_bot
import study_bot

app = Flask(__name__)
# Secure secret key for flask sessions
app.secret_key = os.getenv("FLASK_SECRET_KEY", "brainy_secret_super_key_123")

DB_FILE = os.path.join(study_bot.BASE_DIR, "web_history.db")

# In-memory browser auth sessions: { session_id: { "status": "pending"|"authenticated", "user": { ... } } }
auth_sessions = {}

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_sessions (
                id TEXT PRIMARY KEY,
                user_id INTEGER,
                title TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
            )
        """)
        conn.commit()

init_db()

def verify_telegram_init_data(init_data: str, bot_token: str) -> dict | None:
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data))
        if "hash" not in parsed:
            return None
        hash_value = parsed.pop("hash")
        
        # Sort and join
        sorted_pairs = sorted([f"{k}={v}" for k, v in parsed.items()])
        data_check_string = "\n".join(sorted_pairs)
        
        # HMAC signature validation
        secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        
        if computed_hash == hash_value:
            # Parse user data
            user_data = json.loads(parsed.get("user", "{}"))
            return user_data
    except Exception as e:
        print(f"Error verifying initData: {e}")
    return None

# Serve index.html
@app.route("/")
def index():
    return render_template("index.html")

# ── AUTHENTICATION APIS ──

@app.route("/api/auth/init", methods=["POST"])
def auth_init():
    session_id = str(uuid.uuid4())
    auth_sessions[session_id] = {
        "status": "pending",
        "user": None
    }
    bot_username = "AiChatExpert_Bot"
    return jsonify({
        "session_id": session_id,
        "bot_url": f"https://t.me/{bot_username}?start=sess_{session_id}"
    })

@app.route("/api/auth/status/<session_id>", methods=["GET"])
def auth_status(session_id):
    sess = auth_sessions.get(session_id)
    if not sess:
        return jsonify({"status": "not_found"}), 404
    
    if sess["status"] == "authenticated":
        # Put user details into flask session
        user = sess["user"]
        session["user_id"] = user["id"]
        session["first_name"] = user["first_name"]
        session["username"] = user.get("username", "")
        # Remove from memory as it is completed
        auth_sessions.pop(session_id, None)
        return jsonify({
            "status": "authenticated",
            "user": user
        })
    
    return jsonify({"status": "pending"})

@app.route("/api/auth/verify", methods=["GET"])
def auth_verify():
    session_id = request.args.get("session_id")
    user_id = request.args.get("user_id")
    first_name = request.args.get("first_name", "")
    username = request.args.get("username", "")
    
    if not session_id or not user_id:
        return "❌ Missing session_id or user_id", 400
        
    if session_id in auth_sessions:
        auth_sessions[session_id] = {
            "status": "authenticated",
            "user": {
                "id": int(user_id),
                "first_name": first_name,
                "username": username
            }
        }
        return """
        <html>
            <head>
                <title>Login Successful</title>
                <style>
                    body {
                        background-color: #0d1117;
                        color: #c9d1d9;
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .card {
                        background: rgba(22, 27, 34, 0.8);
                        border: 1px solid #30363d;
                        border-radius: 12px;
                        padding: 30px;
                        text-align: center;
                        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
                        backdrop-filter: blur(4px);
                    }
                    h1 { color: #58a6ff; font-size: 24px; margin-bottom: 10px; }
                    p { font-size: 16px; margin-bottom: 20px; }
                    .success-icon { font-size: 48px; margin-bottom: 15px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="success-icon">🔓</div>
                    <h1>Login Authorized</h1>
                    <p>Verification successful! You can now close this window and return to your chat page.</p>
                </div>
            </body>
        </html>
        """
    return "❌ Invalid or expired session ID", 400

@app.route("/api/auth/initdata", methods=["POST"])
def auth_initdata():
    data = request.json or {}
    init_data = data.get("initData")
    if not init_data:
        return jsonify({"error": "initData missing"}), 400
        
    user_data = verify_telegram_init_data(init_data, study_bot.TELEGRAM_TOKEN)
    if user_data:
        session["user_id"] = user_data["id"]
        session["first_name"] = user_data["first_name"]
        session["username"] = user_data.get("username", "")
        return jsonify({
            "status": "authenticated",
            "user": user_data
        })
    return jsonify({"error": "Invalid signature"}), 401

@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"status": "logged_out"})

# ── API MIDDLEWARE DECORATOR ──

def login_required(f):
    from functools import wraps
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated_function

# ── CHAT SESSION APIS ──

@app.route("/api/sessions", methods=["GET"])
@login_required
def get_sessions():
    user_id = session["user_id"]
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,)
        ).fetchall()
        
    sessions_list = []
    for r in rows:
        sessions_list.append({
            "id": r["id"],
            "title": r["title"],
            "created_at": r["created_at"]
        })
    return jsonify(sessions_list)

@app.route("/api/sessions", methods=["POST"])
@login_required
def create_session():
    user_id = session["user_id"]
    data = request.json or {}
    title = data.get("title", "New Chat")
    session_id = str(uuid.uuid4())
    
    with get_db() as conn:
        conn.execute(
            "INSERT INTO chat_sessions (id, user_id, title) VALUES (?, ?, ?)",
            (session_id, user_id, title)
        )
        conn.commit()
        
    return jsonify({"id": session_id, "title": title})

@app.route("/api/sessions/<session_id>", methods=["PATCH"])
@login_required
def rename_session(session_id):
    user_id = session["user_id"]
    data = request.json or {}
    title = data.get("title")
    if not title:
        return jsonify({"error": "Title required"}), 400
        
    with get_db() as conn:
        conn.execute(
            "UPDATE chat_sessions SET title = ? WHERE id = ? AND user_id = ?",
            (title, session_id, user_id)
        )
        conn.commit()
    return jsonify({"status": "ok"})

@app.route("/api/sessions/<session_id>", methods=["DELETE"])
@login_required
def delete_session(session_id):
    user_id = session["user_id"]
    with get_db() as conn:
        conn.execute("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
        conn.commit()
    return jsonify({"status": "ok"})

@app.route("/api/chat/<session_id>", methods=["GET"])
@login_required
def get_chat_history(session_id):
    user_id = session["user_id"]
    with get_db() as conn:
        # Verify ownership
        sess = conn.execute("SELECT 1 FROM chat_sessions WHERE id = ? AND user_id = ?", (session_id, user_id)).fetchone()
        if not sess:
            return jsonify({"error": "Session not found"}), 404
            
        messages = conn.execute(
            "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC",
            (session_id,)
        ).fetchall()
        
    history = [{"role": m["role"], "content": m["content"]} for m in messages]
    return jsonify(history)

@app.route("/api/chat/send", methods=["POST"])
@login_required
def send_message():
    user_id = session["user_id"]
    first_name = session["first_name"]
    username = session["username"]
    
    data = request.json or {}
    session_id = data.get("session_id")
    content = data.get("content", "").strip()
    
    if not session_id or not content:
        return jsonify({"error": "Missing session_id or content"}), 400
        
    with get_db() as conn:
        # Verify ownership
        sess = conn.execute("SELECT title FROM chat_sessions WHERE id = ? AND user_id = ?", (session_id, user_id)).fetchone()
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        
        # Save user message
        conn.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)",
            (session_id, "user", content)
        )
        conn.commit()
        
        # Fetch last 15 messages for context
        rows = conn.execute(
            "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 15",
            (session_id,)
        ).fetchall()
        
    messages_context = [{"role": r["role"], "content": r["content"]} for r in rows]
    
    # Run intent detection
    intent, payload = study_bot.detect_intent(content)
    
    # Select prompt & max tokens
    system_prompt = study_bot.SYSTEM_PROMPT
    max_tok = None
    
    # Initialize user profile data for motivate context
    user_profile = study_bot.get_user_data(user_id)
    level = user_profile.get("level") or "Class 12"
    
    if intent == "joke":
        system_prompt = study_bot.JOKE_SYSTEM_PROMPT
        max_tok = 150
        messages_context = [{"role": "user", "content": "Tell one genuinely funny joke — preferably a science, programming, or Hinglish wordplay joke."}]
    elif intent == "fact":
        system_prompt = study_bot.FACT_SYSTEM_PROMPT
        max_tok = 200
        categories = ["science", "space", "human body", "history", "technology and AI", "mathematics", "psychology"]
        category = random.choice(categories)
        messages_context = [{"role": "user", "content": f"Give one mind-blowing lesser-known fact about {category}."}]
    elif intent == "tip":
        system_prompt = study_bot.TIP_SYSTEM_PROMPT
        max_tok = 250
        messages_context = [{"role": "user", "content": "Give one powerful productivity or study tip. Make it practical and actionable."}]
    elif intent == "define":
        system_prompt = study_bot.DEFINE_SYSTEM_PROMPT
        max_tok = 350
    elif intent == "summarize":
        system_prompt = study_bot.SUMMARIZE_SYSTEM_PROMPT
        max_tok = 500
    elif intent == "translate":
        system_prompt = study_bot.TRANSLATE_SYSTEM_PROMPT
        max_tok = 400
    elif intent == "motivate":
        system_prompt = study_bot.MOTIVATE_SYSTEM_PROMPT
        max_tok = 250
        total = user_profile.get("total", 0)
        score = user_profile.get("score", 0)
        context_hint = ""
        if total > 0:
            pct = round(score / total * 100)
            if pct < 50:
                context_hint = f"{first_name} is struggling a bit (accuracy: {pct}%), needs encouragement without sugar-coating."
            elif pct >= 80:
                context_hint = f"{first_name} is performing well (accuracy: {pct}%), motivate them to aim even higher."
            else:
                context_hint = f"{first_name} is doing okay (accuracy: {pct}%), push them to level up."
        prompt = (
            f"Give a short, powerful motivational message for {first_name} ({level}).\n"
            f"{context_hint}\n"
            "Make it punchy, real, personal — not generic quotes. Mix English + Hinglish. 5-7 lines max."
        )
        messages_context = [{"role": "user", "content": prompt}]
    elif intent == "search":
        query = payload or content
        try:
            search_results = study_bot.web_search(query, max_results=5)
            ai_prompt = (
                f"User ne search kiya: '{query}'\n\n"
                f"Internet se yeh results aaye hain:\n\n"
                f"{search_results}\n\n"
                f"In results ke basis pe ek clear, accurate, engaging answer do Hinglish mein. "
                f"Agar results mein kafi info nahi hai, toh honestly batao. "
                f"NEVER use **asterisks** markdown. Use emojis and → for formatting."
            )
            messages_context = [{"role": "user", "content": ai_prompt}]
            system_prompt = study_bot.SEARCH_SYSTEM_PROMPT
            max_tok = 600
        except Exception as e:
            print(f"Web search failed: {e}")
    elif intent == "brainy":
        system_prompt = study_bot.BRAINY_SYSTEM_PROMPT
        max_tok = 1000
    elif study_bot.is_offtopic_chat(content):
        system_prompt = study_bot.BANTER_SYSTEM_PROMPT or study_bot.SYSTEM_PROMPT

    # Inject learning contexts just like process_query
    learn_ctx = study_bot.get_learning_context(5)
    liked_ctx = study_bot.get_liked_context(user_id, 5)
    extra = "\n\n".join(c for c in (learn_ctx, liked_ctx) if c)
    if extra:
        system_prompt = system_prompt + "\n\n" + extra

    # Call AI wrapper
    try:
        response_text = study_bot.ai_call(messages_context, system_prompt, max_tok)
        response_text = study_bot.clean_response(response_text)
    except Exception as e:
        print(f"AI Call failed in Web App: {e}")
        response_text = f"❌ Error communicating with AI: {str(e)[:100]}"
        
    # Save response to SQLite
    with get_db() as conn:
        conn.execute(
            "INSERT INTO chat_messages (session_id, role, content) VALUES (?, ?, ?)",
            (session_id, "assistant", response_text)
        )
        title_updated = None
        if sess["title"] == "New Chat":
            words = content.split()[:5]
            new_title = " ".join(words) + ("..." if len(content.split()) > 5 else "")
            conn.execute("UPDATE chat_sessions SET title = ? WHERE id = ?", (new_title, session_id))
            title_updated = new_title
        conn.commit()

    # ── Sync active session history to Supabase/Telegram Bot ──
    try:
        study_bot.load_user_into_memory(user_id, first_name, username)
        if user_id in study_bot.user_conversations:
            study_bot.user_conversations[user_id].append({"role": "user", "content": content})
            study_bot.user_conversations[user_id].append({"role": "assistant", "content": response_text})
            study_bot.trim_history(user_id)
            study_bot.save_user_memory_async(user_id)
    except Exception as se:
        print(f"Sync to Supabase failed: {se}")

    return jsonify({
        "role": "assistant",
        "content": response_text,
        "new_title": title_updated
    })

# ── PROFILE & STATS APIS ──

@app.route("/api/user/profile", methods=["GET"])
@login_required
def get_user_profile():
    user_id = session["user_id"]
    study_bot.load_user_into_memory(user_id, session["first_name"], session["username"])
    profile = study_bot.get_user_data(user_id)
    
    return jsonify({
        "user_id": user_id,
        "first_name": session["first_name"],
        "username": session["username"],
        "level": profile.get("level") or "Not set",
        "score": profile.get("score", 0),
        "total": profile.get("total", 0),
        "joined": profile.get("joined") or "Recently"
    })

@app.route("/api/user/memory", methods=["GET"])
@login_required
def get_user_memory():
    user_id = session["user_id"]
    study_bot.load_user_into_memory(user_id, session["first_name"], session["username"])
    profile = study_bot.get_user_data(user_id)
    liked_notes = profile.get("liked_notes") or []
    
    learn_history = study_bot.get_learning_context(10) or "No custom learning patterns registered yet."
    
    return jsonify({
        "liked_notes": liked_notes,
        "learn_context": learn_history
    })

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
