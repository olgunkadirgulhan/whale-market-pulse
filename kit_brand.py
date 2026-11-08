"""Kanal açıklaması + anahtar kelimeler (2026-11-08). python kit_brand.py  (env: BRAND_DESC, BRAND_KW virgüllü)"""
import os
import shortkit as K

yt = K.yt_client()
ch = yt.channels().list(part='snippet,brandingSettings', mine=True).execute()['items'][0]
print('kanal:', ch['snippet']['title'])
b = ch.get('brandingSettings', {}); b.setdefault('channel', {})
b['channel']['description'] = os.environ['BRAND_DESC']
b['channel']['keywords'] = ' '.join(f'"{k.strip()}"' if ' ' in k.strip() else k.strip() for k in os.environ['BRAND_KW'].split(','))
b['channel']['defaultLanguage'] = 'en'; b['channel'].pop('unsubscribedTrailer', None); b.pop('hints', None)
yt.channels().update(part='brandingSettings', body={'id': ch['id'], 'brandingSettings': b}).execute()
print('✓ açıklama + anahtar kelimeler')
