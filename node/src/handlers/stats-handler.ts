import { Context } from 'hono'
import { RowDataPacket } from 'mysql2/promise'
import { HonoEnvironment } from '../types/application'
import { verifyUserSessionMiddleware } from '../middlewares/verify-user-session-middleare'
import { throwErrorWith } from '../utils/throw-error-with'
import {
  LivecommentsModel,
  LivestreamsModel,
  ReactionsModel,
  UserModel,
} from '../types/models'
import { atoi } from '../utils/integer'

// GET /api/user/:username/statistics
export const getUserStatisticsHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/user/:username/statistics'>) => {
    const username = c.req.param('username')
    // ユーザごとに、紐づく配信について、累計リアクション数、累計ライブコメント数、累計売上金額を算出
    // また、現在の合計視聴者数もだす

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const [[user]] = await conn
        .query<(UserModel & RowDataPacket)[]>(
          'SELECT * FROM users WHERE name = ?',
          [username],
        )
        .catch(throwErrorWith('failed to get user'))

      if (!user) {
        await conn.rollback()
        return c.json('not found user that has the given username', 404)
      }

      // ランク算出
      const [[{
        'score_rank': rank,
      }]] = await conn
        .query<({
          'score_rank': number,
        } & RowDataPacket)[]>(
          `
          select score_rank from (
            SELECT
              id,
              RANK() OVER (ORDER BY score DESC, name DESC) AS score_rank
            FROM users) as users
            where id = ?
          `,
          [user.id],
        )
        .catch(throwErrorWith('failed to count reactions'))

      // リアクション数、ライブコメント数、チップ合計
      const [[{
        'total_reactions': totalReactions,
        'total_livecomments': totalLivecomments,
        'total_tip': totalTip,
        'viewers_count': viewersCount,
      }]] = await conn
        .query<({
          'total_reactions': number,
          'total_livecomments': number,
          'total_tip': number,
          'viewers_count': number,
        } & RowDataPacket)[]>(
          `
            select total_reactions, total_livecomments, total_tip, viewers_count from users where id = ?
          `,
          [user.id],
        )
        .catch(throwErrorWith('failed to count reactions'))

      // お気に入り絵文字
      const [[favoriteEmoji]] = await conn
        .query<(Pick<ReactionsModel, 'emoji_name'> & RowDataPacket)[]>(
          `
            SELECT r.emoji_name
            FROM users u
            INNER JOIN livestreams l ON l.user_id = u.id
            INNER JOIN reactions r ON r.livestream_id = l.id
            WHERE u.name = ?
            GROUP BY emoji_name
            ORDER BY COUNT(*) DESC, emoji_name DESC
            LIMIT 1
          `,
          [username],
        )
        .catch(throwErrorWith('failed to get favorite emoji'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json({
        rank,
        viewers_count: viewersCount,
        total_reactions: totalReactions,
        total_livecomments: totalLivecomments,
        total_tip: totalTip,
        favorite_emoji: favoriteEmoji?.emoji_name,
      })
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/livestream/:livestream_id/statistics
export const getLivestreamStatisticsHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/statistics'>,
  ) => {
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    const redis = await c.get('clientRedis')
    await conn.beginTransaction()

    try {
      let livestream = await redis.get(`livestream-${livestreamId}`);
      if (!livestream) {
        const [[livestreamDb]] = await conn.query<(LivestreamsModel & RowDataPacket)[]>(
          'SELECT * FROM livestreams WHERE id = ?',
          [livestreamId],
        )
        if (!livestreamDb) {
          await conn.rollback()
          return c.json('cannot get stats of not found livestream', 404)
        }
        livestream = livestreamDb
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
      } else {
        livestream = JSON.parse(livestream)
      }

      // ランク算出
      const [[{
        'score_rank': rank,
      }]] = await conn
        .query<({
          'score_rank': number,
        } & RowDataPacket)[]>(
          `
          select score_rank from (
            SELECT
              id,
              RANK() OVER (ORDER BY score DESC, id DESC) AS score_rank
            FROM livestreams) as livestreams
            where id = ?
          `,
          [livestream.id],
        )
        .catch(throwErrorWith('failed to count reactions'))

      // リアクション数、ライブコメント数、チップ合計
      const [[{
        'total_reactions': totalReactions,
        'total_reports': totalReports,
        'max_tip': maxTip,
        'viewers_count': viewersCount,
      }]] = await conn
        .query<({
          'total_reactions': number,
          'total_reports': number,
          'max_tip': number,
          'viewers_count': number,
        } & RowDataPacket)[]>(
          `
            select total_reactions, total_reports, max_tip, viewers_count from livestreams where id = ?
          `,
          [livestream.id],
        )
        .catch(throwErrorWith('failed to count reactions'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json({
        rank,
        viewers_count: viewersCount,
        total_reactions: totalReactions,
        total_reports: totalReports,
        max_tip: maxTip,
      })
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]
