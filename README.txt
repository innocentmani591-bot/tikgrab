TikGrab - Vercel deploy
1. Zip ko extract karein, GitHub par push karein (ya "vercel" CLI se deploy karein).
2. Vercel > Environment Variables: ADMIN_USER, ADMIN_PASS, SECRET (koi lamba random text).
3. Deploy. Site: /  |  Admin: /admin.html
Local: npm install && npm start
Note: Vercel par data.json permanent save nahi hoti (Admin > Site > Download data.json se backup lein).

MongoDB (permanent database)
- Vercel > Settings > Environment Variables: MONGODB_URI = mongodb+srv://USER:PASSWORD@cluster0.bkqysog.mongodb.net/tiktokDownloderDB?appName=Cluster0
- PASSWORD ki jagah asli password likhein (special characters ho to URL-encode karein, e.g. @ = %40).
- Atlas > Network Access > Add IP: 0.0.0.0/0
- MONGODB_URI na ho to data.json use hoti hai. Logs 30 din baad khud delete ho jate hain.
