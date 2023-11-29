import { Context } from 'hono'
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { HonoEnvironment } from '../types/application'
import { verifyUserSessionMiddleware } from '../middlewares/verify-user-session-middleare'
import { defaultUserIDKey } from '../contants'
import {
  LivecommentResponse,
  fillLivecommentResponse,
} from '../utils/fill-livecomment-response'
import { fillLivecommentReportResponse } from '../utils/fill-livecomment-report-response'
import {
  LivecommentsModel,
  LivestreamsModel,
  NgWordsModel,
} from '../types/models'
import { throwErrorWith } from '../utils/throw-error-with'
import { atoi } from '../utils/integer'
import {
  fillLivestreamResponse,
} from '../utils/fill-livestream-response'

// GET /api/livestream/:livestream_id/livecomment
export const getLivecommentsHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/livecomment'>,
  ) => {
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    interface LivecommentRelModel {
      id: number
      comment: string
      tip: number
      created_at: number

      user_id: number
      user_name: string
      user_display_name: string
      user_description: string
      
      icon_id?: number
      icon_image_hash?: string

      theme_id: number
      theme_dark_mode: boolean
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {

      const [[livestream]] = await conn.query<(LivestreamsModel & RowDataPacket)[]>(
        'SELECT * FROM livestreams WHERE id = ?',
        [livestreamId],
      )
      if (!livestream) throw new Error(`not found livestream that has the given id`)
    
      const livestreamResponse = await fillLivestreamResponse(
        conn,
        livestream,
        c.get('runtime').fallbackUserIcon,
      )

      let query =
        `
        select
          livecomments.id,
          livecomments.user_id,
          livecomments.comment,
          livecomments.tip,
          livecomments.created_at,

          users.name as user_name,
          users.display_name as user_display_name,
          users.description as user_description,
          
          icons.id as icon_id,
          icons.image_hash as icon_image_hash,

          themes.id as theme_id,
          themes.dark_mode as theme_dark_mode
        from livecomments
        inner join users on livecomments.user_id = users.id
        left outer join icons on users.id = icons.user_id
        inner join themes on users.id = themes.user_id
        WHERE livecomments.livestream_id = ? ORDER BY livecomments.created_at DESC
        `
      const limit = c.req.query('limit')
      if (limit) {
        const limitNumber = atoi(limit)
        if (limitNumber === false) {
          return c.text('limit query parameter must be integer', 400)
        }
        query += ` LIMIT ${limitNumber}`
      }
      const [livecomments] = await conn
        .query<(LivecommentRelModel & RowDataPacket)[]>(query, [livestreamId])
        .catch(throwErrorWith('failed to get livecomments'))

      const livecommnetResponses: LivecommentResponse[] = []
      for (const livecomment of livecomments) {
        const userResponse = {
          id: livecomment.user_id,
          name: livecomment.user_name,
          display_name: livecomment.user_display_name,
          description: livecomment.user_description,
          theme: {
            id: livecomment.theme_id,
            dark_mode: !!livecomment.theme_dark_mode,
          },
          icon_hash: livecomment.icon_image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
        };
        const livecommentResponse = {
          id: livecomment.id,
          user: userResponse,
          livestream: livestreamResponse,
          comment: livecomment.comment,
          tip: livecomment.tip,
          created_at: livecomment.created_at,
        } satisfies LivecommentResponse
        livecommnetResponses.push(livecommentResponse)
      }

      await conn.commit().catch(throwErrorWith('failed to commit'))
      return c.json(livecommnetResponses)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/livestream/:livestream_id/ngwords
export const getNgwords = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/ngwords'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const [ngwords] = await conn
        .query<(NgWordsModel & RowDataPacket)[]>(
          'SELECT * FROM ng_words WHERE user_id = ? AND livestream_id = ? ORDER BY created_at DESC',
          [userId, livestreamId],
        )
        .catch(throwErrorWith('failed to get NG words'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(
        ngwords.map((ngword) => ({
          id: ngword.id,
          user_id: ngword.user_id,
          livestream_id: ngword.livestream_id,
          word: ngword.word,
          created_at: ngword.created_at,
        })),
      )
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// POST /api/livestream/:livestream_id/livecomment
export const postLivecommentHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/livecomment'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const body = await c.req.json<{ comment: string; tip: number }>()

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()
    try {
      const [[livestream]] = await conn
        .execute<(LivestreamsModel & RowDataPacket)[]>(
          `SELECT * FROM livestreams WHERE id = ?`,
          [livestreamId],
        )
        .catch(throwErrorWith('failed to get livestream'))
      if (!livestream) {
        await conn.rollback()
        return c.text('livestream not found', 404)
      }

      // スパム判定
      const [ngwords] = await conn
        .query<
          (Pick<NgWordsModel, 'id' | 'user_id' | 'livestream_id' | 'word'> &
            RowDataPacket)[]
        >(
          'SELECT id, user_id, livestream_id, word FROM ng_words WHERE user_id = ? AND livestream_id = ?',
          [livestream.user_id, livestreamId],
        )
        .catch(throwErrorWith('failed to get NG words'))

      for (const ngword of ngwords) {
        if (body.comment.includes(ngword.word)) {
          await conn.rollback()
          return c.text('このコメントがスパム判定されました', 400)
        }
      }
      const now = Date.now()
      const [{ insertId: livecommentId }] = await conn
        .query<ResultSetHeader>(
          'INSERT INTO livecomments (user_id, livestream_id, comment, tip, created_at) VALUES (?, ?, ?, ?, ?)',
          [userId, livestreamId, body.comment, body.tip, now],
        )
        .catch(throwErrorWith('failed to insert livecomment'))

      await conn
        .query<ResultSetHeader>(
          'update users set total_livecomments = total_livecomments + 1 where id = (select user_id from livestreams where id = ?)',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))
      
      await conn
        .query<ResultSetHeader>(
          'update users set total_tip = total_tip + ?, score = score + ? where id = (select user_id from livestreams where id = ?)',
          [body.tip, body.tip, livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))
      await conn
        .query<ResultSetHeader>(
          `
          UPDATE livestreams
            SET max_tip = CASE
                WHEN max_tip < ? THEN ?
                ELSE max_tip END,
                total_tip = total_tip + ?,
                score = score + ?
            WHERE id = ?
          `,
          [body.tip, body.tip, body.tip, body.tip, livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      const livecommentResponse = await fillLivecommentResponse(
        conn,
        {
          id: livecommentId,
          user_id: userId,
          livestream_id: livestreamId,
          comment: body.comment,
          tip: body.tip,
          created_at: now,
        },
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill livecomment'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(livecommentResponse, 201)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// POST /api/livestream/:livestream_id/livecomment/:livecomment_id/report
export const reportLivecommentHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<
      HonoEnvironment,
      '/api/livestream/:livestream_id/livecomment/:livecomment_id/report'
    >,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }
    const livecommentId = atoi(c.req.param('livecomment_id'))
    if (livecommentId === false) {
      return c.text('livecomment_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const now = Date.now()

      const [[livestream]] = await conn
        .execute<(LivestreamsModel & RowDataPacket)[]>(
          `SELECT * FROM livestreams WHERE id = ?`,
          [livestreamId],
        )
        .catch(throwErrorWith('failed to get livestream'))
      if (!livestream) {
        await conn.rollback()
        return c.text('livestream not found', 404)
      }

      const [[livecomment]] = await conn
        .execute<(LivecommentsModel & RowDataPacket)[]>(
          `SELECT * FROM livecomments WHERE id = ?`,
          [livecommentId],
        )
        .catch(throwErrorWith('failed to get livecomment'))
      if (!livecomment) {
        await conn.rollback()
        return c.text('livecomment not found', 404)
      }

      const [{ insertId: reportId }] = await conn
        .query<ResultSetHeader>(
          'INSERT INTO livecomment_reports(user_id, livestream_id, livecomment_id, created_at) VALUES (?, ?, ?, ?)',
          [userId, livestreamId, livecommentId, now],
        )
        .catch(throwErrorWith('failed to insert livecomment report'))
      await conn
        .query<ResultSetHeader>(
          'update livestreams set total_reports = total_reports + 1 where id = ?',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      const livecommentReportResponse = await fillLivecommentReportResponse(
        conn,
        {
          id: reportId,
          user_id: userId,
          livestream_id: livestreamId,
          livecomment_id: livecommentId,
          created_at: now,
        },
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill livecomment report'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(livecommentReportResponse, 201)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// POST /api/livestream/:livestream_id/moderate
export const moderateHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/moderate'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const body = await c.req.json<{ ng_word: string }>()

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      // 配信者自身の配信に対するmoderateなのかを検証
      const [ownedLivestreams] = await conn
        .query<(LivecommentsModel & RowDataPacket)[]>(
          'SELECT * FROM livestreams WHERE id = ? AND user_id = ?',
          [livestreamId, userId],
        )
        .catch(throwErrorWith('failed to get livestreams'))

      if (ownedLivestreams.length === 0) {
        await conn.rollback()
        return c.text(
          "A streamer can't moderate livestreams that other streamers own",
          400,
        )
      }

      const [{ insertId: wordId }] = await conn
        .query<ResultSetHeader>(
          'INSERT INTO ng_words(user_id, livestream_id, word, created_at) VALUES (?, ?, ?, ?)',
          [userId, livestreamId, body.ng_word, Date.now()],
        )
        .catch(throwErrorWith('failed to insert new NG word'))


      await conn
        .query(
          `
            DELETE FROM livecomments
            WHERE
            livestream_id = ? AND
            comment like ?;
          `,
          [livestreamId, `%${body.ng_word}%`],
        )
        .catch(
          throwErrorWith(
            'failed to delete old livecomments that hit spams',
          ),
        )

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json({ word_id: wordId }, 201)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]
