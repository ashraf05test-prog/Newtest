# YouTube Shorts Automation Pro v2.0 🚀

এই রিপোজিটরিটিতে একটি শক্তিশালী এবং সম্পূর্ণ **YouTube Shorts Automation** সিস্টেম রয়েছে। এটি ব্যবহার করে আপনি খুব সহজেই বিভিন্ন প্ল্যাটফর্ম (যেমন: TikTok, YouTube, Kuaishou) থেকে ভিডিও ডাউনলোড করতে পারবেন, সেগুলোতে নিজের ভয়েস-ওভার বা অডিও যুক্ত করতে পারবেন এবং সরাসরি ইউটিউবে আপলোড করতে পারবেন।

## 🌟 মূল বৈশিষ্ট্যসমূহ (Key Features)

-   **মাল্টি-প্ল্যাটফর্ম ভিডিও ডাউনলোড:** TikTok, YouTube Shorts এবং Kuaishou থেকে ভিডিও ডাউনলোড করার সুবিধা।
-   **অডিও এক্সট্রাকশন ও মার্জিং:** ভিডিও থেকে অডিও আলাদা করা এবং নতুন অডিও (ভয়েস-ওভার) ভিডিওর সাথে যুক্ত করা।
-   **AI মেটাডেটা জেনারেশন:** Gemini, Grok বা OpenAI ব্যবহার করে ভিডিওর জন্য আকর্ষণীয় টাইটেল, ডেসক্রিপশন এবং ট্যাগ জেনারেট করা।
-   **অটোমেটেড ইউটিউব আপলোড:** সরাসরি সিস্টেম থেকে ইউটিউবে ভিডিও আপলোড করার সুবিধা।
-   **শিডিউলিং সিস্টেম:** নির্দিষ্ট সময়ে ভিডিও অটোমেটিক আপলোড করার জন্য উন্নত শিডিউলার।
-   **Google Drive ইন্টিগ্রেশন:** ভিডিও এবং অডিও ফাইলগুলো সরাসরি গুগল ড্রাইভ থেকে ম্যানেজ করার সুবিধা।
-   **GitHub Actions সাপোর্ট:** `auto_upload.py` স্ক্রিপ্টের মাধ্যমে GitHub Actions ব্যবহার করে অটোমেশন চালানোর সুবিধা।

## 🛠 প্রযুক্তিগত কাঠামো (Tech Stack)

-   **Backend:** Node.js (Express)
-   **Frontend:** HTML5, CSS3 (Modern UI), JavaScript
-   **Automation Script:** Python 3
-   **Tools:** `yt-dlp` (ডাউনলোডের জন্য), `ffmpeg` (ভিডিও এডিটিংয়ের জন্য)
-   **Containerization:** Docker

## 📂 ফাইল স্ট্রাকচার (File Structure)

| ফাইল/ফোল্ডার | বর্ণনা |
| :--- | :--- |
| `server.js` | মূল ব্যাকএন্ড সার্ভার যা API এন্ডপয়েন্টগুলো হ্যান্ডেল করে। |
| `public/index.html` | সিস্টেমের ইউজার ইন্টারফেস (UI)। |
| `auto_upload.py` | ইউটিউবে অটোমেটিক ভিডিও আপলোড করার পাইথন স্ক্রিপ্ট। |
| `Dockerfile` | ডকার ইমেজ তৈরির জন্য কনফিগারেশন। |
| `.github/workflows/` | GitHub Actions-এর মাধ্যমে অটোমেশন চালানোর কনফিগারেশন। |
| `package.json` | প্রজেক্টের ডিপেন্ডেন্সি এবং স্ক্রিপ্টসমূহ। |

## 🚀 কিভাবে শুরু করবেন (Getting Started)

### ১. লোকাল সেটআপ (Local Setup)

প্রথমে রিপোজিটরি ক্লোন করুন:
```bash
git clone https://github.com/ashraf05test-prog/Full-YT-shorts-Automation-Background-video-and-voice-over-.git
cd Full-YT-shorts-Automation-Background-video-and-voice-over-
```

ডিপেন্ডেন্সি ইনস্টল করুন:
```bash
npm install
```

সার্ভার রান করুন:
```bash
node server.js
```
এখন ব্রাউজারে `http://localhost:3000` এ গিয়ে ইন্টারফেসটি দেখতে পাবেন।

### ২. ডকার ব্যবহার করে (Using Docker)

```bash
docker build -t yt-automation .
docker run -p 3000:3000 yt-automation
```

## ⚙️ কনফিগারেশন (Configuration)

অটোমেশন এবং আপলোড ফিচারের জন্য আপনাকে কিছু এনভায়রনমেন্ট ভেরিয়েবল সেট করতে হবে:
- `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN` (YouTube API-এর জন্য)
- `DRIVE_CLIENT_ID`, `DRIVE_CLIENT_SECRET`, `DRIVE_REFRESH_TOKEN` (Google Drive-এর জন্য)
- `GEMINI_API_KEY` বা অন্যান্য AI API কি।

## 📝 লাইসেন্স (License)

এই প্রজেক্টটি MIT লাইসেন্সের অধীনে লাইসেন্সকৃত।

---
*তৈরি করেছেন [ashraf05test-prog](https://github.com/ashraf05test-prog)*
