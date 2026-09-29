# SafeRoute ko online kaise lagayein (aasaan steps)

Do raaste hain. Pehle **Raasta 1** karo (free, 5 minute). Jab asli SMS/call chahiye tab **Raasta 2**.

---

## Raasta 1: Free demo link (5 minute, koi paisa nahi)

Isme app aur website chalegi, camera, GPS, face check sab chalega. Lekin SMS/call **asli nahi jayenge**, sirf app ke andar dikhenge.

1. `saferoute.zip` download karo aur unzip karo (ek `safe-route` folder milega).
2. Browser mein kholo: **https://app.netlify.com/drop**
3. Free account banao (Google se login ho jata hai).
4. `safe-route` **folder** ko us page par drag karke chhod do.
5. 1 minute mein ek link milega, jaise `https://kuch-naam.netlify.app`.
   - Wo link kholo: website dikhegi.
   - "Open the App" dabao: app khulegi.
6. Phone par wo link kholo → browser menu → **"Add to Home screen"**. Ab app phone par icon ki tarah dikhegi.

---

## Raasta 2: Asli SMS aur asli bot call (thoda paisa lagega)

Tumhe 3 account banane honge. Ye kaam sirf tum kar sakte ho (mobile number, email, payment).

### Step A: GitHub par code daalo (free)
1. **https://github.com/signup** par account banao.
2. Upar **+ → New repository**. Naam: `saferoute`. **Private** chuno. Create dabao.
3. "uploading an existing file" link dabao.
4. `safe-route` folder ke **andar ki saari files aur folders** drag karo (models, vendor, site, server bhi). Neeche **Commit changes** dabao.

### Step B: Twilio (SMS aur phone call bhejne wala)
1. **https://www.twilio.com/try-twilio** par account banao, apna mobile number verify karo.
2. Console mein ek **phone number** lo (Get a phone number). India ke liye US number bhi chalta hai.
3. Console home par ye 3 cheezein copy karke rakh lo:
   - **Account SID** (AC se shuru hota hai)
   - **Auth Token**
   - Tumhara Twilio **phone number** (jaise `+1 555...`)
4. Dhyan do:
   - Free trial mein SMS/call sirf un numbers par jata hai jo tumne Twilio mein **verify** kiye hain (Phone Numbers → Verified Caller IDs). Family ke number wahan add karo.
   - Asli use ke liye account **upgrade** (paisa daalna) padega. India mein SMS ke liye DLT registration bhi lagta hai.

### Step C: Render par server chalao
1. **https://render.com** par GitHub se login karo.
2. **New → Blueprint** dabao, apni `saferoute` repository chuno. Render khud `render.yaml` padh lega.
3. Wo 3 cheezein maangega. Twilio wali daal do:
   - `TWILIO_ACCOUNT_SID` = Account SID
   - `TWILIO_AUTH_TOKEN` = Auth Token
   - `TWILIO_FROM` = Twilio number (jaise `+15551234567`, bina space)
4. **Apply / Deploy** dabao. 2-3 minute mein link milega, jaise `https://saferoute.onrender.com`.
5. Render mein service kholo → **Environment** → `APP_KEY` ki value copy karo (ye password jaisa hai).

### Step D: App mein on karo
1. Render wala link phone par kholo → "Open the App".
2. **Setup** tab mein:
   - Apna naam aur **apna phone number** (`+91` ke saath)
   - **Family contacts** ke naam aur number (`+91` ke saath)
   - **Enroll with camera** dabakar apna face register karo
   - **Mode** → "Real, through my SafeRoute server"
   - **Server address** khali chhod do
   - **Server key** mein `APP_KEY` paste karo
   - Asli phone call chahiye to "Also ring my real phone" tick karo
   - **Save**
3. Test: SOS dabao. Family ke phone par SMS aana chahiye. Phir camera ke saamne face dikhao aur "I am safe now" bolo/likho.

---

## Zaroori baatein

- **Police:** police station apps se SMS nahi lete. Abhi alert Setup wale police number par jata hai (default 112). Asli police connection ke liye state police ya **112 ERSS** team se baat karni hogi.
- **Render free plan** 15 minute khaali rehne par so jata hai, pehla alert 1 minute late ho sakta hai. Asli use ke liye "Starter" plan (lagbhag $7/mahina) lo.
- **Kharcha (andaza):** Twilio number ~$1-2/mahina, har SMS/call ke paise alag. Render Starter ~$7/mahina.
- Web app phone lock hone par zyada der tracking nahi kar pati. Pakka solution ke liye baad mein Android app banana hoga.
- Face check abhi photo se dhoka kha sakta hai. Asli use se pehle "aankh jhapkao" wala check lagana chahiye.
