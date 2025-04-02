import uuid 
from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = "wubba lubba dub dub"
socketio = SocketIO(app)
# cors_allowed_origins="https://domain.com",
users_in_room = {}
rooms_sid = {}
names_sid = {}
room_passwords = {}
room_tokens = {} 

@app.route("/", methods=["GET", "POST"])
def index():
    if request.method == "POST":
        room_id = request.form.get('room_id')
        display_name = request.form.get('display_name')
        room_password = request.form.get('room_password') 
        mute_audio = request.form.get('mute_audio')
        mute_video = request.form.get('mute_video')

        if not room_id or not display_name:
            return jsonify({"error": "Room ID and Display Name are required."}), 400
        
        if room_id in room_passwords:
            if room_passwords[room_id] != room_password:
                return jsonify({"error": "Incorrect room password."}), 400
        else:
            room_passwords[room_id] = room_password
            room_tokens[room_id] = str(uuid.uuid4())

        token = room_tokens[room_id]
        return jsonify({"token": token}), 200

    return render_template("index.html", rooms=users_in_room)

@app.route("/join", methods=["GET"])
def join():
    display_name = request.args.get('display_name')
    mute_audio = request.args.get('mute_audio')
    mute_video = request.args.get('mute_video')
    room_id = request.args.get('room_id')
    token = request.args.get('token') 

    if room_id not in room_tokens or room_tokens[room_id] != token:
        return redirect(url_for('index', error="Invalid token. Please login again."))

    if not display_name or not room_id:
        return redirect(url_for('index'))

    session['user'] = {
        "room_id": room_id,
        "name": display_name,
        "mute_audio": mute_audio,
        "mute_video": mute_video
    }

    return render_template(
        "room.html",
        room_id=room_id,
        display_name=session['user']["name"],
        mute_audio=session['user']["mute_audio"],
        mute_video=session['user']["mute_video"]
    )

@socketio.on("connect")
def on_connect():
    sid = request.sid
    print(f"New socket connected: {sid}")

@socketio.on("join-room")
def on_join_room(data):
    sid = request.sid
    room_id = data.get("room_id")

    if not room_id or session.get('user', {}).get('room_id') != room_id:
        print(f"Invalid room_id or session for {sid}")
        return

    display_name = session['user']["name"]
    join_room(room_id)

    rooms_sid[sid] = room_id
    names_sid[sid] = display_name

    print(f"[{room_id}] New member joined: {display_name}<{sid}>")
    emit("user-connect", {"sid": sid, "name": display_name}, broadcast=True, include_self=False, room=room_id)

    update_user_list(sid, room_id)

@socketio.on("send_message")
def handle_send_message(data):
    room_id = data.get("room_id")
    message = data.get("message")
    display_name = session['user']["name"]
    
    if room_id and message:
        emit("receive_message", {
            "message": message,
            "display_name": display_name
        }, room=room_id)

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    if sid in rooms_sid:
        room_id = rooms_sid.pop(sid)
        display_name = names_sid.pop(sid, "Unknown")

        print(f"[{room_id}] Member left: {display_name}<{sid}>")
        emit("user-disconnect", {"sid": sid}, broadcast=True, include_self=False, room=room_id)

        if room_id in users_in_room:
            users_in_room[room_id].remove(sid)
            if not users_in_room[room_id]:
                users_in_room.pop(room_id)

        print(f"\nUpdated users: {users_in_room}\n")

@socketio.on("data")
def on_data(data):
    if not isinstance(data, dict):
        print(f"Received non-dict data: {data}")
        return

    sender_sid = data.get('sender_id')
    target_sid = data.get('target_id')

    if sender_sid != request.sid:
        print(f"[Not supposed to happen!] request.sid and sender_id don't match!!!")
        return

    emit('data', data, room=target_sid)

def update_user_list(sid, room_id):
    if room_id not in users_in_room:
        users_in_room[room_id] = [sid]
        emit("user-list", {"my_id": sid})
    else:
        usrlist = {u_id: names_sid.get(u_id, "Unknown") for u_id in users_in_room[room_id]}
        emit("user-list", {"list": usrlist, "my_id": sid})
        users_in_room[room_id].append(sid)
    print(f"\nUpdated users: {users_in_room}\n")

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000)
