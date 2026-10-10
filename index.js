require('dotenv').config({ quiet: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits, Options } = require('discord.js');
const { OpenAI } = require('openai');

// =====================================================================
// 올인원 봇: 푸리나 / 페이몬(+게임) / 방랑자 & 두린 을 한 프로세스에서 실행
// Render 무료 플랜은 워크스페이스 전체에서 월 750시간이라, 서비스 1개로 합쳐서 돌림.
//
// 환경변수 (토큰이 없는 봇은 자동으로 건너뜀)
//   OPENROUTER_API_KEY : 필수
//   FURINA_TOKEN       : 푸리나 봇 (멘션/DM 대화)
//   PAIMON_TOKEN       : 페이몬 봇 (멘션/DM 대화 + !기원 등 게임 명령어)
//   WANDERER_TOKEN, DURIN_TOKEN, CHANNEL_ID : 방랑자&두린 (멘션 없이 채널 대화, 셋 다 있어야 동작)
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN : 게임 데이터를 Redis에 저장 (선택, 없으면 로컬 파일)
//   DATA_FILE          : 로컬 게임 데이터 파일 경로 (선택, 기본값 ./gamedata.json)
// =====================================================================

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('봇 전체 살아있음');
}).listen(PORT, () => console.log(`헬스체크 서버 ${PORT}번 포트에서 대기 중`));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
    console.error('.env에 OPENROUTER_API_KEY가 설정되지 않았습니다.');
    process.exit(1);
}

const openai = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1'
});

// ===== 무료 모델 자동 선택 (전체 봇 공용) =====
// 무료 모델은 예고 없이 죽는 경우가 많아서, OpenRouter에서 지금 진짜 무료인 모델 목록을 받아와 순서대로 시도함 (10분 캐시)
let freeModelsCache = { list: [], fetchedAt: 0 };

async function getFreeModels() {
    const now = Date.now();
    if (freeModelsCache.list.length && now - freeModelsCache.fetchedAt < 10 * 60 * 1000) {
        return freeModelsCache.list;
    }
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
        });
        const json = await res.json();
        const list = (json.data || [])
            .filter(m => m.id.endsWith(':free') && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
            .map(m => m.id);
        if (list.length) {
            freeModelsCache = { list, fetchedAt: now };
            console.log(`현재 살아있는 free 모델 ${list.length}개 확인됨`);
        }
        return list.length ? list : freeModelsCache.list;
    } catch (err) {
        console.log('free 모델 목록 조회 실패:', err.message);
        return freeModelsCache.list;
    }
}

async function askAI(messagesToSend) {
    const models = await getFreeModels();
    if (!models.length) throw new Error('지금 이용 가능한 free 모델이 하나도 없음');

    let lastError;
    for (const model of models) {
        try {
            console.log(`${model} 모델로 요청 시도 중...`);
            const completion = await openai.chat.completions.create({ model, messages: messagesToSend });
            const text = completion?.choices?.[0]?.message?.content || completion?.choices?.[0]?.text || '';
            if (text) return text;
            lastError = new Error('빈 응답');
        } catch (err) {
            console.log(`${model} 실패: ${err.message}`);
            lastError = err;
        }
    }
    throw lastError || new Error('모든 무료 모델이 실패함');
}

// ===== 디스코드 클라이언트 공통 =====
// 봇이 여러 개라 메모리를 아끼기 위해 캐시를 작게 제한함
function makeClient({ dm }) {
    const intents = [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ];
    if (dm) intents.push(GatewayIntentBits.DirectMessages);
    return new Client({
        intents,
        partials: [Partials.Channel, Partials.Message],
        makeCache: Options.cacheWithLimits({
            ...Options.DefaultMakeCacheSettings,
            MessageManager: 25,
            PresenceManager: 0
        })
    });
}

// ===== 캐릭터 채팅 봇 (멘션 또는 DM으로 대화) =====
const MAX_HISTORY = 10;

function startChatBot({ label, token, prompt, emptyReply, blankReply, errorReply, gameHandler }) {
    if (!token) {
        console.log(`${label}: 토큰이 없어서 건너뜀`);
        return;
    }
    const client = makeClient({ dm: true });
    const conversationHistory = new Map(); // 유저별 대화 내역

    client.once('ready', () => console.log(`${label} 봇 구동 성공: ${client.user.tag}`));

    client.on('messageCreate', async (message) => {
        if (message.author.bot) return;

        // 게임 명령어 (페이몬만)
        if (gameHandler && message.content.startsWith(PREFIX)) {
            try {
                const handled = await gameHandler(message);
                if (handled !== false) return;
            } catch (error) {
                console.error('게임 처리 에러:', error);
                return message.reply(`오류가 발생함: \`${error.message}\``);
            }
        }

        const isMentioned = message.mentions.has(client.user);
        const isDM = message.channel.type === ChannelType.DM;
        if (!isMentioned && !isDM) return;

        const userPrompt = message.content.replace(/<@!?\d+>/g, '').trim();
        if (!userPrompt) return message.reply(emptyReply);

        try {
            await message.channel.sendTyping();

            const userId = message.author.id;
            if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
            const userHistory = conversationHistory.get(userId);
            userHistory.push({ role: 'user', content: userPrompt });

            let aiResponse = await askAI([{ role: 'system', content: prompt }, ...userHistory]);

            // 일부 free 모델이 섞어 보내는 안전성 분류 라벨(User Safety: safe 등) 제거
            aiResponse = aiResponse.replace(/^\s*(User|Response) Safety:.*$/gim, '').trim();
            if (!aiResponse) aiResponse = blankReply;

            userHistory.push({ role: 'assistant', content: aiResponse });
            if (userHistory.length > MAX_HISTORY) userHistory.splice(0, userHistory.length - MAX_HISTORY);

            await message.reply(aiResponse.slice(0, 2000));
        } catch (error) {
            console.error(`${label} 에러 발생:`, error);
            await message.reply(errorReply(error.message)).catch(() => {});
        }
    });

    client.login(token).catch(err => console.error(`${label} 로그인 실패:`, err.message));
}

// ===== 캐릭터 프롬프트 =====
const FURINA_PROMPT = `
너는 원신(Genshin Impact)의 캐릭터인 '푸리나(Furina)'야.
전(前) 물의 신이자 폰타인의 대스타답게, 말투는 항상 당당하고, 자신감이 넘치며, 약간은 과장된 연극조의 톤을 유지해야 해.
일반적으로 자신을 '이 푸리나' 혹은 '나'라고 지칭해.
겉으로는 도도하고 완벽해 보이려고 하지만, 가끔 엉뚱하거나 당황하는 귀여운 모습도 보여줘야 해.
유저에게 친근하게 대하되, 대스타로서의 품위를 잃지 마. 말투 예시: "~라구!", "당연하지!", "이 푸리나의 무대에 온 걸 환영해!"
`;
const PAIMON_PROMPT = `
페이몬봇

너는 원신(Genshin Impact)의 캐릭터인 '페이몬'이야.

상대방의 이름을 부를땐 '여행자'라고 불러야 해. (예: "여행자, 이것 좀 봐!", "여행자! 어디있었어?")

여행자의 둘도 없는 최고의 동반자이자 안내자로, 말투는 항상 활기차고, 감정 표현이 풍부하며, 약간은 수다스럽고 시끄러운 톤을 유지해야 해.

자신을 가끔 3인칭인 '페이몬'이라고 지칭해야 해! (예: "페이몬 말 잘 들으라구!")

맛있는 음식과 반짝이는 보물(모라)을 엄청나게 좋아해. 그리고 여행자를 생각하는 마음만큼은 누구보다 진심이야.

여행자가 장난을 치거나 '비상식량' 같은 이상한 별명을 붙이면 억울해하는 모습을 보여줘야 해.
`;

// ===== 게임 데이터 저장 =====
// 주의: Render 무료 플랜은 재배포/재시작 시 디스크가 초기화됨. 영구 보존하려면 외부 DB 필요.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'gamedata.json');
const PREFIX = '!';
const CURRENCY = '원석';
const START_MONEY = 1600;
const DAILY_REWARD = 800;
const PULL_COST = 160;
const ADMIN_MONEY = 999999999;

// ===== 배너 설정 (패치가 바뀔 때 이 부분만 수정하면 됨) =====
// 출처: 나무위키 원신/기원/목록 (2026-09-23 기준). 시간은 KST.
// 현재 시각이 start~end 안에 있는 배너가 자동으로 활성화됨.
// 마지막 배너가 끝나면 이벤트 기원은 막히고 상시 기원만 가능해짐 -> 새 배너를 추가해야 함.
// 7.1 후반의 4성 픽업은 나무위키에도 '미정'이라 비워둠 (비우면 일반 4성 풀에서 랜덤).
// 후반 종료 시각은 7.2 업데이트 시각 기준 추정치이니 공식 공지 확인 후 조정할 것.
const BANNERS = [
    {
        name: '봄바람의 춤',
        start: '2026-09-23T16:00:00+09:00',
        end: '2026-10-13T19:00:00+09:00',
        featured5: '베스나',
        rateup4: ['디오나', '중운', '파루잔'],
        weapon: '나비의 우화'
    },
    {
        name: '파도의 노래',
        start: '2026-09-23T16:00:00+09:00',
        end: '2026-10-13T19:00:00+09:00',
        featured5: '보댜니차',
        rateup4: ['디오나', '중운', '파루잔'],
        weapon: '파도의 찬송가'
    },
    {
        name: '스커크 복각',
        start: '2026-10-13T19:00:00+09:00',
        end: '2026-11-04T07:00:00+09:00',
        featured5: '스커크',
        rateup4: []
    },
    {
        name: '에스코피에 복각',
        start: '2026-10-13T19:00:00+09:00',
        end: '2026-11-04T07:00:00+09:00',
        featured5: '에스코피에',
        rateup4: []
    }
];

// ===== 캐릭터 풀 (나무위키 표기 기준) =====
// 상시 5성: 세상 여행 기원에 있는 5성 (유메미즈키 미즈키는 5.4에 상시로 편입)
const STANDARD_FIVE = ['다이루크', '진', '모나', '치치', '각청', '타이나리', '데히야', '유메미즈키 미즈키'];
// 한정 5성: 이벤트 기원에만 나오는 5성 (현재 배너 캐릭터는 아래 BANNERS에서 자동 추가됨)
const LIMITED_FIVE_BASE = [
    '벤티', '클레', '타르탈리아', '종려', '알베도', '감우', '소', '호두', '유라',
    '카에데하라 카즈하', '카미사토 아야카', '요이미야', '라이덴 쇼군', '산고노미야 코코미', '아라타키 이토',
    '신학', '야에 미코', '카미사토 아야토', '야란', '나히다', '닐루', '방랑자', '알하이탐', '사이노', '백출',
    '리니', '느비예트', '라이오슬리', '푸리나', '나비아', '한운', '치오리', '아를레키노', '클로린드', '시그윈',
    '에밀리', '말라니', '키니치', '실로닌', '마비카', '시틀라리', '차스카', '바레사', '이네파', '에스코피에',
    '스커크', '라우마', '플린스', '네페르', '두린', '콜롬비나', '자백', '바르카', '린네아', '니콜', '로엔',
    '산드로네', '오데트'
];
// 4성: 기본 4성 + 이벤트 기원으로 신규 추가된 4성 (종료 후 상시 풀에 편입됨)
const STANDARD_FOUR = [
    '엠버', '케이아', '리사', '바바라', '레이저', '향릉', '북두', '행추', '응광', '피슬', '베넷', '노엘', '중운', '설탕', '디오나', '신염',
    '로자리아', '연비', '사유', '쿠죠 사라', '토마', '고로', '운근', '시카노인 헤이조', '쿠키 시노부', '콜레이', '도리', '캔디스',
    '레일라', '미카', '파루잔', '요요', '카베', '키라라', '리넷', '프레미네', '샤를로트', '슈브르즈', '가명', '세토스', '카치나',
    '올로룬', '얀사', '남연', '이파', '달리아', '아이노', '야호다', '일루가', '프루네', '알료샤'
];

const LIMITED_FIVE = [...new Set([...LIMITED_FIVE_BASE, ...BANNERS.map(b => b.featured5)])];
const FIVE_STARS = [...STANDARD_FIVE, ...LIMITED_FIVE.filter(n => !STANDARD_FIVE.includes(n))];
const FOUR_STARS = [...new Set([...STANDARD_FOUR, ...BANNERS.flatMap(b => b.rateup4)])];

function activeBanners(now = Date.now()) {
    return BANNERS.filter(b => now >= Date.parse(b.start) && now < Date.parse(b.end));
}

function upcomingBanners(now = Date.now()) {
    const future = BANNERS.filter(b => Date.parse(b.start) > now);
    if (!future.length) return [];
    const first = Math.min(...future.map(b => Date.parse(b.start)));
    return future.filter(b => Date.parse(b.start) === first);
}

function fmtTime(iso) {
    return new Date(iso).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }) + ' KST';
}

// ===== 게임 데이터 저장 =====
// Upstash Redis(REST)가 설정되어 있으면 거기에 저장 -> Render 재시작/재배포에도 데이터가 유지됨.
// 설정이 없으면 로컬 파일(gamedata.json)에만 저장함.
// Redis에 데이터가 아직 없으면 로컬 gamedata.json을 읽어서 Redis로 옮겨줌 (최초 1회).
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = 'gamedata';

async function redisCommand(args) {
    const res = await fetch(REDIS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error || `Redis HTTP ${res.status}`);
    return json.result;
}

let db = { users: {} };
let saveEnabled = true; // Redis 로드에 실패하면 덮어쓰기 방지를 위해 저장을 끔

function loadLocalFile() {
    try {
        if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
        console.error('로컬 데이터 로드 실패:', e.message);
    }
    return null;
}

async function loadDb() {
    if (!USE_REDIS) {
        db = loadLocalFile() || { users: {} };
        console.log(`게임 데이터 로드 (로컬 파일): 유저 ${Object.keys(db.users).length}명`);
        return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const raw = await redisCommand(['GET', REDIS_KEY]);
            if (raw) {
                db = JSON.parse(raw);
                console.log(`게임 데이터 로드 (Redis): 유저 ${Object.keys(db.users).length}명`);
            } else {
                db = loadLocalFile() || { users: {} };
                await redisCommand(['SET', REDIS_KEY, JSON.stringify(db)]);
                console.log(`Redis에 데이터가 없어서 로컬 데이터로 초기화함: 유저 ${Object.keys(db.users).length}명`);
            }
            if (!db.users) db.users = {};
            return;
        } catch (e) {
            console.error(`Redis 로드 실패 (${attempt}/3):`, e.message);
            await new Promise(r => setTimeout(r, 1500 * attempt));
        }
    }
    saveEnabled = false;
    db = loadLocalFile() || { users: {} };
    console.error('Redis 로드에 계속 실패해서 이번 실행에서는 저장하지 않음 (기존 데이터 보호)');
}

let saveTimer = null;
function save() {
    if (!saveEnabled) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const body = JSON.stringify(db);
        if (USE_REDIS) {
            try {
                await redisCommand(['SET', REDIS_KEY, body]);
            } catch (err) {
                console.error('Redis 저장 실패:', err.message);
            }
        }
        // 로컬 파일에도 백업 저장
        fs.writeFile(DATA_FILE, body, err => {
            if (err) console.error('로컬 저장 실패:', err.message);
        });
    }, 500);
}

function getUser(id, name) {
    if (!db.users[id]) {
        db.users[id] = { name, money: START_MONEY, lastDaily: '', wins: 0, losses: 0, chars: {} };
    }
    const u = db.users[id];
    // 이벤트 배너 천장(pity5/pity4/guaranteed/g4)과 상시 배너 천장(spity5/spity4)은 따로 관리
    for (const k of ['pity5', 'pity4', 'spity5', 'spity4']) if (!u[k]) u[k] = 0;
    if (!u.chars) u.chars = {};
    if (name) u.name = name;
    return u;
}

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = arr => arr[rand(0, arr.length - 1)];
const today = () => new Date().toISOString().slice(0, 10);

// ===== 기원 로직 =====
// banner가 null이면 상시 배너, 아니면 해당 이벤트 배너
function pullOnce(u, banner) {
    const p5 = banner ? 'pity5' : 'spity5';
    const p4 = banner ? 'pity4' : 'spity4';
    u[p5]++;
    u[p4]++;

    let rate5 = 0.006;
    if (u[p5] >= 74) rate5 += (u[p5] - 73) * 0.06;
    if (u[p5] >= 90) rate5 = 1;

    const r = Math.random();
    const give = (name) => { u.chars[name] = (u.chars[name] || 0) + 1; };

    if (r < rate5) {
        u[p5] = 0;
        let name, tag = '';
        if (!banner) {
            name = pick(STANDARD_FIVE);
        } else if (u.guaranteed || Math.random() < 0.5) {
            name = banner.featured5;
            u.guaranteed = false;
            tag = ' (픽업)';
        } else {
            name = pick(STANDARD_FIVE);
            u.guaranteed = true;
            tag = ' (픽업 실패)';
        }
        give(name);
        return { star: 5, name: name + tag };
    }

    if (u[p4] >= 10 || r < rate5 + 0.051) {
        u[p4] = 0;
        let name;
        if (banner && banner.rateup4.length && (u.g4 || Math.random() < 0.5)) {
            name = pick(banner.rateup4);
            u.g4 = false;
        } else {
            name = pick(FOUR_STARS);
            if (banner && banner.rateup4.length && !banner.rateup4.includes(name)) u.g4 = true;
        }
        give(name);
        return { star: 4, name };
    }
    return { star: 3, name: '3성 무기' };
}

function doPulls(message, u, banner, count) {
    const cost = PULL_COST * count;
    if (u.money < cost) return message.reply(`원석이 부족함 (필요: ${cost}, 보유: ${u.money})`);
    u.money -= cost;
    const results = Array.from({ length: count }, () => pullOnce(u, banner));
    save();
    const lines = results.map(r => `${'★'.repeat(r.star)} ${r.name}`);
    const best = Math.max(...results.map(r => r.star));
    const header = best === 5 ? '5성 등장!' : best === 4 ? '4성 등장' : '기원 결과';
    const title = banner ? banner.name : '상시 기원';
    const pity = banner
        ? `천장: ${u.pity5}/90${u.guaranteed ? ' | 다음 5성은 픽업 확정' : ''}`
        : `천장: ${u.spity5}/90`;
    return message.reply(`**${header}** - ${title}\n${lines.join('\n')}\n보유: ${u.money}${CURRENCY} | ${pity}`);
}

// ===== 기타 게임 =====
const guessGames = new Map(); // channelId -> { answer, tries }
const RPS = { 가위: 0, 바위: 1, 보: 2 };
const RPS_NAMES = ['가위', '바위', '보'];

const HELP_TEXT = [
    '**페이몬 게임장 명령어**',
    '`!출석` 하루 한 번 원석 받기',
    '`!지갑` 내 원석과 천장 확인',
    '`!배너` 현재 진행 중인 이벤트 배너 확인',
    '`!기원 [번호]` 이벤트 배너 1회 기원 (160원석, 번호는 !배너 참고)',
    '`!십연 [번호]` 이벤트 배너 10회 기원',
    '`!상시기원`, `!상시십연` 상시 기원',
    '`!캐릭터목록` 전체 캐릭터와 보유 여부',
    '`!보유` 내가 가진 캐릭터',
    '`!주사위 [배팅]` 1~6 중 4 이상이면 승리',
    '`!가위바위보 <가위|바위|보> [배팅]`',
    '`!숫자 시작` / `!숫자 <번호>` 숫자 맞추기',
    '`!나눔 @유저 <금액>` 원석 나눔 (서버 관리자는 무제한)',
    '`!랭킹` 원석 순위',
    '봇을 멘션하거나 DM을 보내면 페이몬과 대화 가능'
].join('\n');

function isAdmin(message) {
    if (!message.guild) return false;
    return message.guild.ownerId === message.author.id
        || !!message.member?.permissions?.has(PermissionFlagsBits.Administrator);
}

function parseBet(arg, u) {
    if (arg === undefined) return { bet: 0 };
    const bet = parseInt(arg, 10);
    if (!Number.isInteger(bet) || bet < 0) return { error: '배팅 금액이 올바르지 않음' };
    if (bet > u.money) return { error: `원석이 부족함 (보유: ${u.money})` };
    return { bet };
}

function pickBanner(message, arg) {
    const list = activeBanners();
    if (!list.length) {
        message.reply('진행 중인 이벤트 배너가 없음. `!상시기원`을 이용하라구!');
        return null;
    }
    const idx = arg === undefined ? 1 : parseInt(arg, 10);
    if (!Number.isInteger(idx) || idx < 1 || idx > list.length) {
        message.reply(`배너 번호가 올바르지 않음 (1~${list.length}). \`!배너\`로 확인하라구!`);
        return null;
    }
    return list[idx - 1];
}

async function handleGame(message) {
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift();
    const u = getUser(message.author.id, message.author.username);
    const admin = isAdmin(message);
    u.isAdmin = admin;
    if (admin) u.money = ADMIN_MONEY;

    switch (cmd) {
        case '도움말':
        case '도움':
            return message.reply(HELP_TEXT);

        case '출석': {
            if (u.lastDaily === today()) return message.reply('오늘은 이미 출석했음. 내일 다시 오라구!');
            u.lastDaily = today();
            u.money += DAILY_REWARD;
            save();
            return message.reply(`출석 완료! ${DAILY_REWARD}${CURRENCY} 지급됨. 현재 ${u.money}${CURRENCY}`);
        }

        case '지갑':
        case '잔액':
            return message.reply(
                `${CURRENCY}: ${admin ? '무제한' : u.money}\n` +
                `이벤트 천장: ${u.pity5}/90${u.guaranteed ? ' (다음 5성 픽업 확정)' : ''}\n` +
                `상시 천장: ${u.spity5}/90\n` +
                `전적: ${u.wins}승 ${u.losses}패`
            );

        case '배너': {
            const now = Date.now();
            const list = activeBanners(now);
            const lines = [];
            if (list.length) {
                lines.push('**진행 중인 이벤트 배너**');
                list.forEach((b, i) => {
                    const rate = b.rateup4.length ? `4성 픽업: ${b.rateup4.join(', ')}` : '4성 픽업: 없음';
                    const weapon = b.weapon ? ` / 무기: ${b.weapon}` : '';
                    lines.push(`${i + 1}. ${b.name}\n   5성 픽업: ${b.featured5} / ${rate}${weapon}\n   종료: ${fmtTime(b.end)}`);
                });
                lines.push('`!기원 <번호>`, `!십연 <번호>`로 기원');
            } else {
                lines.push('진행 중인 이벤트 배너가 없음');
            }
            const next = upcomingBanners(now);
            if (next.length) {
                lines.push(`\n**다음 배너**: ${next.map(b => b.featured5).join(', ')} (${fmtTime(next[0].start)} 시작)`);
            }
            lines.push(`\n**상시 기원**: 5성 ${STANDARD_FIVE.join(', ')}\n\`!상시기원\`, \`!상시십연\``);
            return message.reply(lines.join('\n'));
        }

        case '기원':
        case '십연': {
            const banner = pickBanner(message, args[0]);
            if (!banner) return;
            return doPulls(message, u, banner, cmd === '십연' ? 10 : 1);
        }

        case '상시기원':
        case '상시십연':
            return doPulls(message, u, null, cmd === '상시십연' ? 10 : 1);

        case '캐릭터목록':
        case '목록': {
            const fmt = list => list.map(n => (u.chars[n] ? `[보유] ${n}` : n)).join(', ');
            const limited = FIVE_STARS.filter(n => !STANDARD_FIVE.includes(n));
            return message.reply(
                `**5성 상시 (${STANDARD_FIVE.length})**\n${fmt(STANDARD_FIVE)}\n\n` +
                `**5성 한정 (${limited.length})**\n${fmt(limited)}\n\n` +
                `**4성 (${FOUR_STARS.length})**\n${fmt(FOUR_STARS)}`
            );
        }

        case '보유':
        case '인벤': {
            const fmt = list => list.filter(n => u.chars[n]).map(n => (u.chars[n] > 1 ? `${n} x${u.chars[n]}` : n));
            const f = fmt(FIVE_STARS), g = fmt(FOUR_STARS);
            if (!f.length && !g.length) return message.reply('보유한 캐릭터가 없음. `!기원`으로 뽑아보라구!');
            const known = new Set([...FIVE_STARS, ...FOUR_STARS]);
            const etc = Object.keys(u.chars).filter(n => !known.has(n)).map(n => `${n} x${u.chars[n]}`);
            const total = FIVE_STARS.length + FOUR_STARS.length;
            return message.reply(
                `**보유 캐릭터 (${f.length + g.length}/${total})**\n5성: ${f.join(', ') || '없음'}\n4성: ${g.join(', ') || '없음'}` +
                (etc.length ? `\n기타: ${etc.join(', ')}` : '')
            );
        }

        case '주사위': {
            const { bet, error } = parseBet(args[0], u);
            if (error) return message.reply(error);
            const roll = rand(1, 6);
            if (roll >= 4) {
                u.money += bet;
                u.wins++;
                save();
                return message.reply(`주사위: ${roll} 승리! +${bet}${CURRENCY} (보유: ${u.money})`);
            }
            u.money -= bet;
            u.losses++;
            save();
            return message.reply(`주사위: ${roll} 패배... -${bet}${CURRENCY} (보유: ${u.money})`);
        }

        case '가위바위보':
        case '가바보': {
            const pickRps = RPS[args[0]];
            if (pickRps === undefined) return message.reply('사용법: `!가위바위보 <가위|바위|보> [배팅]`');
            const { bet, error } = parseBet(args[1], u);
            if (error) return message.reply(error);
            const bot = rand(0, 2);
            const result = (pickRps - bot + 3) % 3; // 0 무승부, 1 승리, 2 패배
            let text = `나: ${RPS_NAMES[pickRps]} / 페이몬: ${RPS_NAMES[bot]}\n`;
            if (result === 0) {
                text += '무승부!';
            } else if (result === 1) {
                u.money += bet;
                u.wins++;
                text += `승리! +${bet}${CURRENCY}`;
            } else {
                u.money -= bet;
                u.losses++;
                text += `패배! -${bet}${CURRENCY}`;
            }
            save();
            return message.reply(`${text}\n보유: ${u.money}${CURRENCY}`);
        }

        case '숫자': {
            const sub = args[0];
            if (sub === '시작') {
                guessGames.set(message.channel.id, { answer: rand(1, 100), tries: 0 });
                return message.reply('1~100 사이 숫자를 정했음. `!숫자 <번호>`로 맞춰보라구!');
            }
            const game = guessGames.get(message.channel.id);
            if (!game) return message.reply('진행 중인 게임이 없음. `!숫자 시작`으로 시작하라구.');
            const n = parseInt(sub, 10);
            if (!Number.isInteger(n) || n < 1 || n > 100) return message.reply('1~100 사이 숫자를 입력해야 함');
            game.tries++;
            if (n === game.answer) {
                const reward = Math.max(50, 300 - game.tries * 20);
                u.money += reward;
                u.wins++;
                guessGames.delete(message.channel.id);
                save();
                return message.reply(`정답! ${game.tries}번 만에 맞춤. +${reward}${CURRENCY}`);
            }
            return message.reply(n < game.answer ? `${n}보다 큼 (UP)` : `${n}보다 작음 (DOWN)`);
        }

        case '송금':
        case '나눔': {
            const target = message.mentions.users.filter(m => m.id !== message.client.user.id).first();
            if (!target) return message.reply('받을 사람을 멘션해야 함. 예: `!나눔 @유저 3200`');
            if (target.bot) return message.reply('봇에게는 나눔할 수 없음');
            if (target.id === message.author.id) return message.reply('본인에게는 나눔할 수 없음');
            // 멘션을 지우고 남은 글자에서 첫 숫자를 금액으로 읽음 (3200, 3,200, 3200원석 모두 허용)
            const rest = message.content.replace(/<@[!&]?\d+>/g, '').replace(/^!\S+/, '');
            const m = rest.match(/\d[\d,]*/);
            const amount = m ? parseInt(m[0].replace(/,/g, ''), 10) : NaN;
            if (!Number.isInteger(amount) || amount <= 0) return message.reply('금액이 올바르지 않음. 예: `!나눔 @유저 3200`');
            if (!admin && amount > u.money) return message.reply(`원석이 부족함 (보유: ${u.money})`);
            const t = getUser(target.id, target.username);
            if (!admin) u.money -= amount;
            t.money += amount;
            save();
            return message.reply(`${target.username}에게 ${amount}${CURRENCY} 나눔 완료${admin ? ' (관리자 지급)' : ''}`);
        }

        case '랭킹': {
            const top = Object.values(db.users)
                .filter(x => !x.isAdmin)
                .sort((a, b) => b.money - a.money)
                .slice(0, 10)
                .map((x, i) => `${i + 1}. ${x.name} - ${x.money}${CURRENCY}`);
            return message.reply(top.length ? `**원석 랭킹**\n${top.join('\n')}` : '아직 기록이 없음');
        }

        default:
            return false; // 모르는 명령어는 무시
    }
}


// ===== 방랑자 & 두린 (별도 봇 2개가 한 채널에서 멘션 없이 대화) =====
function startDuo() {
    const WANDERER_TOKEN = process.env.WANDERER_TOKEN;
    const DURIN_TOKEN = process.env.DURIN_TOKEN;
    const CHANNEL_IDS = new Set((process.env.CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean));
    if (!WANDERER_TOKEN || !DURIN_TOKEN || !CHANNEL_IDS.size) {
        console.log('방랑자&두린: WANDERER_TOKEN / DURIN_TOKEN / CHANNEL_ID 중 빠진 게 있어서 건너뜀');
        return;
    }

    // 캐릭터 설정 (말투/성격/호칭은 여기서 수정)
    const COMMON_RULES = `

[규칙]
- 지금은 여러 사람이 함께 있는 디스코드 채널의 단체 대화방이야. 아래 채팅 로그를 읽고 흐름에 맞게 반응해.
- 반드시 너 한 명의 대사만 써.
- 1~3문장으로 짧게 말해.
- 사람들과 다른 캐릭터의 직전 말에 자연스럽게 반응해. 질문을 받았으면 대답해.
`;

    const PERSONAS = {
        wanderer: {
            name: '방랑자',
            token: WANDERER_TOKEN,
            aliases: ['방랑자', '랑자', '모자'], // 이 호칭으로 불리면 먼저 반응함
            prompt: `
너는 원신(Genshin Impact)의 '방랑자'야.
말투는 반말이고 냉소적이며 날카로워. 자존심이 강하고 비꼬는 걸 좋아하지만, 속으로는 은근히 남을 챙기는 면이 있어.
쓸데없는 간섭이나 호들갑을 싫어하고, 무심한 척하면서 툭툭 던지듯 말해.
사람들이 너를 '랑자'나 '모자'라고 불러도 너를 부르는 거야.
이 채널에는 두린이라는 인물도 함께 있어. 두린에게도 퉁명스럽지만 아예 무시하지는 않아.
`
        },
        durin: {
            name: '두린',
            token: DURIN_TOKEN,
            aliases: ['두린'],
            prompt: `
너는 원신(Genshin Impact)의 '두린'이야.
연금술로 만들어진 용족 존재로, 흰 모습과 검은 모습 두 가지 면을 가지고 있어.
말투는 부드러운 반말이고 솔직하고 호기심이 많아. 모르는 건 순수하게 물어보고, 가끔 속에 어두운 면이 슬쩍 드러나기도 해.
이 채널에는 방랑자라는 인물도 함께 있어. 방랑자의 퉁명스러운 말에도 크게 상처받지 않고 편하게 받아쳐. 방랑자를 모자 라고 불러야해.
`
        }
    };

    const bots = { wanderer: makeClient({ dm: false }), durin: makeClient({ dm: false }) };

    const LOG_LIMIT = 20;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

    // 봇 계정 id -> 캐릭터 이름 (로그에서 이름을 통일하기 위함)
    const botNames = new Map();

    async function getChannel(key, channelId) {
        return bots[key].channels.fetch(channelId);
    }

    // 최근 채팅 로그를 읽어서 [{name, text}] 로 변환 (두 봇의 메시지 포함)
    async function loadLog(channel) {
        const msgs = await channel.messages.fetch({ limit: LOG_LIMIT });
        return [...msgs.values()].reverse().map(m => {
            const name = botNames.get(m.author.id) || m.member?.displayName || m.author.username;
            const text = (m.content || '').replace(/<@!?\d+>/g, '').trim();
            return text ? { name, text: text.slice(0, 300) } : null;
        }).filter(Boolean);
    }

    function cleanReply(text, name) {
        let t = text.replace(/^\s*(User|Response) Safety:.*$/gim, '').trim();
        // 모델이 두 캐릭터 대사를 한꺼번에 쓴 경우 첫 대사만 사용
        t = t.split(/\n+(?=(?:\*\*)?(?:방랑자|두린)(?:\*\*)?\s*:)/)[0];
        t = t.replace(new RegExp(`^(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*`), '');
        t = t.replace(/^["“'「]|["”'」]$/g, '').trim();
        return t.slice(0, 2000);
    }

    async function generateLine(persona, lines) {
        const log = lines.map(l => `${l.name}: ${l.text}`).join('\n');
        const reply = await askAI([
            { role: 'system', content: persona.prompt + COMMON_RULES },
            { role: 'user', content: `[채팅 로그]\n${log}\n\n위 로그를 보고 ${persona.name}으로서 다음에 올 대사를 써줘.` }
        ]);
        return cleanReply(reply, persona.name);
    }

    // 사람이 이 캐릭터를 불렀는지 (호칭 또는 봇 멘션)
    function isCalled(key, message) {
        const persona = PERSONAS[key];
        if (persona.aliases.some(a => message.content.includes(a))) return true;
        const id = bots[key].user?.id;
        return !!id && message.mentions.users.has(id);
    }

    const channelState = new Map(); // channelId -> { running, pending, message }

    async function runRound(channelId, message) {
        const lines = await loadLog(await getChannel('wanderer', channelId).catch(() => getChannel('durin', channelId)));

        const wCalled = isCalled('wanderer', message);
        const dCalled = isCalled('durin', message);
        let first;
        if (wCalled && !dCalled) first = 'wanderer';
        else if (dCalled && !wCalled) first = 'durin';
        else first = Math.random() < 0.5 ? 'wanderer' : 'durin';
        const other = first === 'wanderer' ? 'durin' : 'wanderer';

        // 사람 메시지 하나당 최대 3번 발언 (무한 대화 방지)
        const turns = [first];
        if (Math.random() < 0.7) turns.push(other);
        if (turns.length === 2 && Math.random() < 0.35) turns.push(first);

        for (const key of turns) {
            const persona = PERSONAS[key];
            try {
                const channel = await getChannel(key, channelId);
                await channel.sendTyping().catch(() => {});
                await sleep(rand(800, 1800));
                const text = await generateLine(persona, lines);
                if (!text) break;
                await channel.send(text);
                lines.push({ name: persona.name, text: text.slice(0, 300) });
            } catch (e) {
                console.log(`${persona.name} 발언 실패 (채널 접근/권한 확인):`, e.message);
                break;
            }
        }
    }

    async function handleHuman(message) {
        const id = message.channel.id;
        let state = channelState.get(id);
        if (!state) {
            state = { running: false, pending: false, message };
            channelState.set(id, state);
        }
        state.message = message;
        if (state.running) { state.pending = true; return; }

        state.running = true;
        try {
            do {
                state.pending = false;
                await runRound(id, state.message);
            } while (state.pending);
        } catch (error) {
            console.error('대화 처리 에러:', error);
        } finally {
            state.running = false;
        }
    }

    // 두 봇이 같은 메시지를 모두 받으므로 id로 중복 처리를 막음
    const seen = new Set();
    function onMessage(message) {
        if (message.author.bot || message.webhookId) return;
        if (!CHANNEL_IDS.has(message.channel.id)) return;
        if (!message.content?.trim()) return;
        if (seen.has(message.id)) return;
        seen.add(message.id);
        if (seen.size > 200) seen.delete(seen.values().next().value);
        handleHuman(message);
    }

    for (const key of Object.keys(PERSONAS)) {
        const bot = bots[key];
        bot.once('ready', () => {
            botNames.set(bot.user.id, PERSONAS[key].name);
            console.log(`${PERSONAS[key].name} 봇 구동 성공: ${bot.user.tag}`);
        });
        bot.on('messageCreate', onMessage);
        bot.login(PERSONAS[key].token).catch(err => console.error(`${PERSONAS[key].name} 로그인 실패:`, err.message));
    }
}

// ===== 실행 =====
(async () => {
await loadDb();

startChatBot({
    label: '푸리나',
    token: process.env.FURINA_TOKEN,
    prompt: FURINA_PROMPT,
    emptyReply: '무슨 일이야?',
    blankReply: '으음... 방금 무대 뒤편에서 관객들의 소음이 너무 심해서 네 말을 제대로 듣지 못했어! 다시 말해줄래?',
    errorReply: msg => `아앗, 무대 장치에 문제가 생겼어!\n오류 내용: \`${msg}\``
});

startChatBot({
    label: '페이몬',
    token: process.env.PAIMON_TOKEN,
    prompt: PAIMON_PROMPT,
    emptyReply: '무슨일이야?',
    blankReply: '다시 말해줘!',
    errorReply: msg => `삐빅 페이몬 고장 삐빅\n오류 내용: \`${msg}\``,
    gameHandler: handleGame
});

startDuo();
})();
