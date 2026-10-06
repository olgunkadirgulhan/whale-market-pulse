"""Kanal düzeyinde hedef kitleyi 'çocuklara yönelik değil' yapar (tekrar çalıştırılabilir)."""
import os
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

env = lambda a, b: os.environ.get(a) or os.environ[b]
creds = Credentials(None, refresh_token=env('YT_REFRESH_TOKEN', 'YOUTUBE_REFRESH_TOKEN'),
                    client_id=env('YT_CLIENT_ID', 'YOUTUBE_CLIENT_ID'),
                    client_secret=env('YT_CLIENT_SECRET', 'YOUTUBE_CLIENT_SECRET'),
                    token_uri='https://oauth2.googleapis.com/token')
yt = build('youtube', 'v3', credentials=creds, cache_discovery=False)
ch = yt.channels().list(part='id,snippet,status', mine=True).execute()['items'][0]
print(f"{ch['snippet']['title']}: önce madeForKids={ch['status'].get('madeForKids')}")
yt.channels().update(part='status', body={'id': ch['id'], 'status': {'selfDeclaredMadeForKids': False}}).execute()
after = yt.channels().list(part='status', id=ch['id']).execute()['items'][0]['status']
print(f"sonra madeForKids={after.get('madeForKids')} selfDeclared={after.get('selfDeclaredMadeForKids')}")
