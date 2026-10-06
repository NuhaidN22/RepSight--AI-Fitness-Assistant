import sqlite3, os
DB = os.path.join(os.path.dirname(__file__), "app.db")
EXERCISES = [("Back Squat","legs"),("Front Squat","legs"),("Goblet Squat","legs"),("Leg Press","legs"),("Lunge","legs"),("Romanian Deadlift","hamstrings"),("Deadlift","back"),("Leg Curl","hamstrings"),("Leg Extension","quads"),("Calf Raise","calves"),
("Bench Press","chest"),("Incline Bench Press","chest"),("Dumbbell Press","chest"),("Push-up","chest"),("Chest Fly","chest"),("Dip","chest"),
("Overhead Press","shoulders"),("Lateral Raise","shoulders"),("Face Pull","shoulders"),
("Pull-up","back"),("Lat Pulldown","back"),("Barbell Row","back"),("Seated Row","back"),("Dumbbell Row","back"),
("Biceps Curl","arms"),("Hammer Curl","arms"),("Triceps Pushdown","arms"),("Skull Crusher","arms"),
("Plank","core"),("Hanging Leg Raise","core"),("Hip Thrust","glutes")]

def conn():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

def init():
    c = conn()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS exercise(id INTEGER PRIMARY KEY, name TEXT UNIQUE, muscle TEXT);
    CREATE TABLE IF NOT EXISTS set_log(id INTEGER PRIMARY KEY, date TEXT, exercise TEXT, reps INT, weight REAL, rpe REAL);
    CREATE TABLE IF NOT EXISTS body_metric(id INTEGER PRIMARY KEY, date TEXT, weight REAL, height REAL);
    CREATE TABLE IF NOT EXISTS form_analysis(id INTEGER PRIMARY KEY, date TEXT, exercise TEXT, rep_count INT, score REAL, metrics TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS progress_photo(id INTEGER PRIMARY KEY, date TEXT, path TEXT, caption TEXT);
    CREATE TABLE IF NOT EXISTS routine(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS routine_item(id INTEGER PRIMARY KEY, routine_id INT, exercise TEXT, sets INT, reps INT);
    CREATE TABLE IF NOT EXISTS coach_message(id INTEGER PRIMARY KEY, ts TEXT DEFAULT CURRENT_TIMESTAMP, role TEXT, content TEXT);
    """)
    c.executemany("INSERT OR IGNORE INTO exercise(name,muscle) VALUES(?,?)", EXERCISES)
    c.commit(); c.close()
