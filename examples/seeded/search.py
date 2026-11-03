# A deliberate defect, to try the reviewer end to end. This pull request is closed, never merged.
import sqlite3
from flask import Flask, request

app = Flask(__name__)


@app.route("/search")
def search():
    term = request.args.get("q", "")
    db = sqlite3.connect("app.db")
    rows = db.execute("SELECT id, title FROM posts WHERE title LIKE '%" + term + "%'").fetchall()
    return {"results": rows}
