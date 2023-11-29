import { Context } from 'hono'
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { HonoEnvironment } from '../types/application'
import { verifyUserSessionMiddleware } from '../middlewares/verify-user-session-middleare'
import { defaultUserIDKey } from '../contants'
import {
  ReactionResponse,
  fillReactionResponse,
} from '../utils/fill-reaction-response'
import { throwErrorWith } from '../utils/throw-error-with'
import { LivestreamsModel } from '../types/models'
import { atoi } from '../utils/integer'
import {
  fillLivestreamResponse,
} from '../utils/fill-livestream-response'

// GET /api/livestream/:livestream_id/reaction
export const getReactionsHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/reaction'>,
  ) => {
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    interface ReactionsRelModel {
      id: number
      livestream_id: number
      emoji_name: string
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
        `SELECT
        reactions.id,
        reactions.user_id,
        reactions.livestream_id,
        reactions.emoji_name,
        reactions.created_at,
  
        users.name as user_name,
        users.display_name as user_display_name,
        users.description as user_description,
        
        icons.id as icon_id,
        icons.image_hash as icon_image_hash,

        themes.id as theme_id,
        themes.dark_mode as theme_dark_mode
        FROM reactions
          inner join users on users.id = reactions.user_id
          left outer join icons on users.id = icons.user_id
          inner join themes on users.id = themes.user_id
          WHERE reactions.livestream_id = ? ORDER BY reactions.created_at DESC`
      const limit = c.req.query('limit')
      if (limit) {
        const limitNumber = atoi(limit)
        if (limitNumber === false) {
          return c.text('limit query parameter must be integer', 400)
        }
        query += ` LIMIT ${limitNumber}`
      }

      const [reactions] = await conn
        .query<(ReactionsRelModel & RowDataPacket)[]>(query, [livestreamId])
        .catch(throwErrorWith('failed to get reactions'))

      const reactionResponses: ReactionResponse[] = []
      for (const reaction of reactions) {
        const userResponse = {
          id: reaction.user_id,
          name: reaction.user_name,
          display_name: reaction.user_display_name,
          description: reaction.user_description,
          theme: {
            id: reaction.theme_id,
            dark_mode: !!reaction.theme_dark_mode,
          },
          icon_hash: reaction.icon_image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
        };
        const reactionResponse = {
          id: reaction.id,
          emoji_name: reaction.emoji_name,
          user: userResponse,
          livestream:  livestreamResponse,
          created_at: reaction.created_at,
        }

        reactionResponses.push(reactionResponse)
      }

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(reactionResponses)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// POST /api/livestream/:livestream_id/reaction
export const postReactionHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/reaction'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const body = await c.req.json<{ emoji_name: string }>()

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const now = Date.now()
      const [{ insertId: reactionId }] = await conn
        .query<ResultSetHeader>(
          'INSERT INTO reactions (user_id, livestream_id, emoji_name, created_at) VALUES (?, ?, ?, ?)',
          [userId, livestreamId, body.emoji_name, now],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      await conn
        .query<ResultSetHeader>(
          'update users set total_reactions = total_reactions + 1, score = score + 1 where id = (select user_id from livestreams where id = ?)',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))
      await conn
        .query<ResultSetHeader>(
          'update livestreams set total_reactions = total_reactions + 1, score = score + 1 where id = ?',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      const reactionResponse = await fillReactionResponse(
        conn,
        {
          id: reactionId,
          emoji_name: body.emoji_name,
          user_id: userId,
          livestream_id: livestreamId,
          created_at: now,
        },
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill reaction'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(reactionResponse, 201)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]
