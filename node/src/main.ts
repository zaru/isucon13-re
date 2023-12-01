import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPool } from 'mysql2/promise'
import { CookieStore, sessionMiddleware } from 'hono-sessions'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import {
  ApplicationRuntime,
  HonoEnvironment,
  Runtime,
} from './types/application'
import {
  getLivecommentsHandler,
  postLivecommentHandler,
  getNgwords,
  reportLivecommentHandler,
  moderateHandler,
} from './handlers/livecomment-handler'
import {
  reserveLivestreamHandler,
  searchLivestreamsHandler,
  getMyLivestreamsHandler,
  getUserLivestreamsHandler,
  getLivestreamHandler,
  getLivecommentReportsHandler,
  enterLivestreamHandler,
  exitLivestreamHandler,
} from './handlers/livestream-handler'
import { GetPaymentResult } from './handlers/payment-handler'
import {
  postReactionHandler,
  getReactionsHandler,
} from './handlers/reaction-handler'
import {
  getUserStatisticsHandler,
  getLivestreamStatisticsHandler,
} from './handlers/stats-handler'
import { getTagHandler, getStreamerThemeHandler } from './handlers/top-handler'
import {
  registerHandler,
  loginHandler,
  getMeHandler,
  getUserHandler,
  getIconHandler,
  postIconHandler,
} from './handlers/user-handler'
import bcrypt from 'bcryptjs'
import Redis from 'ioredis'
import { LivestreamsModel } from './types/models'

let fallbackUserIcon: Readonly<ArrayBuffer>|null = null;

const runtime = {
  exec: async (cmd: string[]) =>
    new Promise((resolve, reject) => {
      const proc = spawn(cmd[0], cmd.slice(1))
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (data) => (stdout += data))
      proc.stderr.on('data', (data) => (stderr += data))
      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(
            new Error(`command failed with code ${code}\n${stderr}\n${stdout}`),
          )
        }
      })
    }),
  hashPassword: async (password: string) => bcrypt.hashSync(password, 4),
  comparePassword: async (password: string, hash: string) => {
    // Bunビルトインだとbcryptバージョンが異なるので一致しない
    // return await Bun.password.verify(password, hash)
    return bcrypt.compareSync(password,hash)
  },
  fallbackUserIcon: () => {
    if (fallbackUserIcon) {
      return Promise.resolve(fallbackUserIcon);
    }
    // eslint-disable-next-line unicorn/prefer-module, unicorn/prefer-top-level-await
    return readFile(join(__dirname, '../../img/NoImage.jpg')).then((v) => {
      const buf = v.buffer
      if (buf instanceof ArrayBuffer) {
        fallbackUserIcon = buf;
        return buf
      } else {
        throw new TypeError(`NoImage.jpg should be ArrayBuffer, but ${buf}`)
      }
    })
  },
} satisfies Runtime

const pool = createPool({
  user: process.env['ISUCON13_MYSQL_DIALCONFIG_USER'] ?? 'isucon',
  password: process.env['ISUCON13_MYSQL_DIALCONFIG_PASSWORD'] ?? 'isucon',
  database: process.env['ISUCON13_MYSQL_DIALCONFIG_DATABASE'] ?? 'isupipe',
  host: process.env['ISUCON13_MYSQL_DIALCONFIG_ADDRESS'] ?? '127.0.0.1',
  port: Number(process.env['ISUCON13_MYSQL_DIALCONFIG_PORT'] ?? '3306'),
  connectionLimit: 10,
})

const clientRedis = new Redis();

if (!process.env['ISUCON13_POWERDNS_SUBDOMAIN_ADDRESS']) {
  throw new Error(
    'envionment variable ISUCON13_POWERDNS_SUBDOMAIN_ADDRESS is not set',
  )
}
const powerDNSSubdomainAddress =
  process.env['ISUCON13_POWERDNS_SUBDOMAIN_ADDRESS']

const store = new CookieStore()

const applicationDeps = {
  ...runtime,
  powerDNSSubdomainAddress,
} satisfies ApplicationRuntime

const app = new Hono<HonoEnvironment>()
app.use('*', logger())
app.use(
  '*',
  sessionMiddleware({
    store,
    encryptionKey: '24553845-c33d-4a87-b0c3-f7a0e17fd82f',
    cookieOptions: {
      path: '/',
      domain: 'u.isucon.dev',
      maxAge: 60_000,
    },
  }),
)
app.use('*', async (c, next) => {
  c.set('pool', pool)
  c.set('clientRedis', clientRedis)
  c.set('runtime', applicationDeps)
  await next()
})
app.use('*', async (c, next) => {
  await next()
  if (c.res.status >= 400) {
    console.error(c.res.status, await c.res.clone().text())
  }
})

// 初期化
app.post('/api/initialize', async (c) => {
  try {
    await runtime.exec(['../sql/init.sh'])
    const conn = await c.get('pool').getConnection()
    const redis = await c.get('clientRedis')
    const [users] = await conn.query<(UserModel & RowDataPacket)[]>(
      'SELECT * FROM users',
      [],
    )
    for (const user of users) {
      await redis.set(`user-${user.id}`, JSON.stringify({
        id: user.id,
        name: user.name,
        display_name: user.display_name,
        password: user.password,
        description: user.description,
        score: user.score,
        viewers_count: user.viewers_count,
        total_reactions: user.total_reactions,
        total_livecomments: user.total_livecomments,
        total_tip: user.total_tip,
        dark_mode: user.dark_mode,
        image_hash: user.image_hash,
      }))
    }

    const [livestreams] = await conn.query<(LivestreamsModel & RowDataPacket)[]>(
      'SELECT * FROM livestreams',
      [],
    )
    for (const livestream of livestreams) {
      await redis.set(`livestream-${livestream.id}`, JSON.stringify({
        id: livestream.id,
        user_id: livestream.user_id,
        title: livestream.title,
        description: livestream.description,
        playlist_url: livestream.playlist_url,
        thumbnail_url: livestream.thumbnail_url,
        start_at: livestream.start_at,
        end_at: livestream.end_at,
        score: livestream.score,
        viewers_count: livestream.viewers_count,
        total_reactions: livestream.total_reactions,
        total_reports: livestream.total_reports,
        max_tip: livestream.max_tip,
        total_tip: livestream.total_tip,
        tags: livestream.tags,
      }))
    }

    return c.json({ language: 'node' })
  } catch (error) {
    console.log('init.sh failed with')
    console.log(error)
    return c.text('failed to initialize', 500)
  }
})

// top
app.get('/api/tag', getTagHandler)
app.get('/api/user/:username/theme', ...getStreamerThemeHandler)

// livestream
// reserve livestream
app.post('/api/livestream/reservation', ...reserveLivestreamHandler)
// list livestream
app.get('/api/livestream/search', searchLivestreamsHandler)
app.get('/api/livestream', ...getMyLivestreamsHandler)
app.get('/api/user/:username/livestream', ...getUserLivestreamsHandler)
// get livestream
app.get('/api/livestream/:livestream_id', ...getLivestreamHandler)
// get polling livecomment timeline
app.get('/api/livestream/:livestream_id/livecomment', ...getLivecommentsHandler)
// ライブコメント投稿
app.post(
  '/api/livestream/:livestream_id/livecomment',
  ...postLivecommentHandler,
)
app.post('/api/livestream/:livestream_id/reaction', ...postReactionHandler)
app.get('/api/livestream/:livestream_id/reaction', ...getReactionsHandler)

// (配信者向け)ライブコメントの報告一覧取得API
app.get(
  '/api/livestream/:livestream_id/report',
  ...getLivecommentReportsHandler,
)
app.get('/api/livestream/:livestream_id/ngwords', ...getNgwords)
// ライブコメント報告
app.post(
  '/api/livestream/:livestream_id/livecomment/:livecomment_id/report',
  ...reportLivecommentHandler,
)
// 配信者によるモデレーション (NGワード登録)
app.post('/api/livestream/:livestream_id/moderate', ...moderateHandler)

// livestream_viewersにINSERTするため必要
// ユーザ視聴開始 (viewer)
app.post('/api/livestream/:livestream_id/enter', ...enterLivestreamHandler)
// ユーザ視聴終了 (viewer)
app.delete('/api/livestream/:livestream_id/exit', ...exitLivestreamHandler)

// user
app.post('/api/register', registerHandler)
app.post('/api/login', loginHandler)
app.get('/api/user/me', ...getMeHandler)
// フロントエンドで、配信予約のコラボレーターを指定する際に必要
app.get('/api/user/:username', ...getUserHandler)
app.get('/api/user/:username/statistics', ...getUserStatisticsHandler)
app.get('/api/user/:username/icon', ...getIconHandler)
app.post('/api/icon', ...postIconHandler)

// stats
// ライブ配信統計情報
app.get(
  '/api/livestream/:livestream_id/statistics',
  ...getLivestreamStatisticsHandler,
)

// // 課金情報
app.get('/api/payment', GetPaymentResult)

export default {
  port: process.env['ISUCON13_NODE_PORT'] || 8080,
  fetch: app.fetch,
};
