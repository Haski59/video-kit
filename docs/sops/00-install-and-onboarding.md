# Install & Onboarding SOP

**Made For**
Client Capital members setting up the Video Kit for the first time on their own Mac, with no coding experience.

**SOP Intention**
Get from "I have the link" to "the kit knows my brand and is ready to edit" in one sitting, with every tool checked and nothing left half-installed.

**Process Summary**
You paste one line into Claude Code (or Terminal). It installs everything into `~/Video Kit`, adds a
**Video Kit** app to your Applications folder and opens the app in your browser. You fill in your
profile once. After that you open Video Kit, drop a recording and press one button. It updates itself.

## The Steps Broken Down

### Step 1: Check Your Mac
- A Mac with an Apple chip (M1 or newer) and about 10 GB free.
- Claude Code installed and signed in (claude.com/claude-code). A Pro or Max plan is recommended; the kit uses Claude for scripts, post copy and choosing the best moments.

### Step 2: Paste The Install Line
Paste this into Claude Code (or the Terminal app) and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/Haski59/video-kit/main/install.sh | bash
```

A Terminal window opens and installs the free tools: ffmpeg, the speech-to-text engine and model (1.6 GB), Node.js, the voice engine and the kit's Claude plugins. It takes about 15 minutes.
- **It asks for your password:** that's Homebrew (only on Macs that don't have it). Type your Mac password and press Return; the letters don't show while you type.
- When everything is in, your browser opens **Video Kit**.

### Step 3: Fill In My Profile
The app opens on **My profile**. Fill in:
- your name and brand;
- who you help;
- what you sell;
- your call to action, word for word, with the link;
- how you sound;
- words to avoid;
- proof you're allowed to mention;
- names that get misspelled;
- your brand colour.

Click **Save my profile**. The kit only ever claims what you write here.

### Step 4: Make Your First Video
On **Edit a recording**:
1. Drop a recording onto the frame, or click **Choose from my Mac**.
2. Pick **Long video + shorts**.
3. Click **Make my videos**.

You can watch the progress strip, which runs Listen → Cut → Plan → Render → Check. When it's done, your videos appear below.

### Step 5: Every Time After That
Open **Video Kit** from Applications, Launchpad or Spotlight, then drop and click. It fetches any update first. Keep its small window open while you work.

### Practical Example
> You drop `pricing-talk.mov`, choose **Long video + shorts**, and click **Make my videos**. Twelve minutes later you have L001 (**Ready to post**) and three shorts: S001 and S002 are **Ready**, and S003 **Needs a look** with the note "Listen around 0:41: a cut may clip a word". You click **Make thumbnail**, type `NO MORE DISCOUNTS`, then **Write post copy**.

## Pre-Launch Checklist
- Opening **Video Kit** from Applications opens the app with no setup panel showing.
- **My profile** is saved, and your CTA wording and link are exact.
- Your first recording came out with a player and a status on its card.
- You know where your files go: a recording you drop in is copied into `~/Video Kit/projects/` (your original is untouched); **Choose from my Mac** uses it where it is; everything the kit makes lands in `~/Video Kit/output/`.
