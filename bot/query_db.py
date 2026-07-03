import sqlite3
import os
import json
from datetime import datetime, timedelta

db_path = r'C:\Users\Egor.adm-notebook\.local\share\mimocode\mimocode.db'
if not os.path.exists(db_path):
    print('Database not found')
    exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get current project (look for project with worktree matching current directory)
current_dir = os.getcwd()
print(f"Current directory: {current_dir}")

# Get all projects
cursor.execute("SELECT id, worktree, name FROM project")
projects = cursor.fetchall()
print("\nProjects found:")
for proj in projects:
    print(f"  ID: {proj[0]}, Worktree: {proj[1]}, Name: {proj[2]}")

# Find project that matches current directory or parent
matching_project = None
for proj in projects:
    if proj[1] and current_dir.startswith(proj[1]):
        matching_project = proj
        break

if matching_project:
    print(f"\nMatching project: {matching_project[0]}")
    project_id = matching_project[0]
else:
    print("\nNo matching project found")
    project_id = None

# Get recent sessions for this project (last 7 days) - exclude checkpoint-writer sessions
if project_id:
    seven_days_ago = int((datetime.now() - timedelta(days=7)).timestamp() * 1000)
    cursor.execute("""
        SELECT id, title, time_created, time_updated 
        FROM session 
        WHERE project_id = ? AND time_created > ? AND title NOT LIKE 'checkpoint-writer:%'
        ORDER BY time_created DESC
    """, (project_id, seven_days_ago))
    sessions = cursor.fetchall()
    print(f"\nRecent user sessions (last 7 days): {len(sessions)}")
    for session in sessions:
        print(f"  ID: {session[0]}, Title: {session[1]}, Created: {session[2]}, Updated: {session[3]}")
        
        # Get messages for this session
        cursor.execute("""
            SELECT id, agent_id, time_created, data 
            FROM message 
            WHERE session_id = ? 
            ORDER BY time_created
        """, (session[0],))
        messages = cursor.fetchall()
        print(f"    Messages: {len(messages)}")
        
        # Get parts for assistant messages to understand what was done
        for msg in messages:
            msg_data = json.loads(msg[3]) if msg[3] else {}
            if msg_data.get('role') == 'assistant':
                # Get parts for this message
                cursor.execute("""
                    SELECT data 
                    FROM part 
                    WHERE message_id = ? 
                    ORDER BY time_created
                """, (msg[0],))
                parts = cursor.fetchall()
                for part in parts:
                    part_data = json.loads(part[0]) if part[0] else {}
                    part_type = part_data.get('type', '')
                    if part_type == 'text':
                        text = part_data.get('text', '')
                        if len(text) > 200:
                            text = text[:200] + '...'
                        print(f"      Text: {text}")
                    elif part_type == 'tool':
                        tool = part_data.get('tool', '')
                        state = part_data.get('state', {})
                        input_data = state.get('input', {})
                        output_data = state.get('output', {})
                        print(f"      Tool: {tool}")
                        if 'command' in input_data:
                            cmd = input_data['command']
                            if len(cmd) > 100:
                                cmd = cmd[:100] + '...'
                            print(f"        Command: {cmd}")
else:
    print("\nCannot query sessions without project ID")

conn.close()