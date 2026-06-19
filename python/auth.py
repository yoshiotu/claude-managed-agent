import jwt
import datetime
from functools import wraps
from flask import request, jsonify

SECRET_KEY = "my-secret-key"

def generate_token(user_id: str, role: str) -> str:
    payload = {
        "user_id": user_id,
        "role": role,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=1),
        "iat": datetime.datetime.utcnow(),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def verify_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload
    except jwt.ExpiredSignatureError:
        return {"error": "Token has expired"}
    except jwt.InvalidTokenError:
        return {"error": "Invalid token"}

def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get("Authorization")
        if not auth_header:
            return jsonify({"error": "No token provided"}), 401

        token = auth_header.split(" ")[-1]
        payload = verify_token(token)

        if "error" in payload:
            return jsonify(payload), 401

        if payload.get("role") == "admin":
            return f(*args, **kwargs)
        else:
            return jsonify({"error": "Unauthorized"}), 403

    return decorated
