import { Context } from 'hono'
import { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { HonoEnvironment } from '../types/application'
import { verifyUserSessionMiddleware } from '../middlewares/verify-user-session-middleare'
import { defaultUserIDKey } from '../contants'
import {
  LivestreamResponse,
  fillLivestreamResponse,
} from '../utils/fill-livestream-response'
import {
  LivecommentReportResponse,
  fillLivecommentReportResponse,
} from '../utils/fill-livecomment-report-response'
import {
  LivecommentReportsModel,
  LivestreamTagsModel,
  LivestreamsModel,
  ReservationSlotsModel,
  TagsModel,
  UserModel,
} from '../types/models'
import { throwErrorWith } from '../utils/throw-error-with'
import { atoi } from '../utils/integer'
import { tagMaster } from '../utils/tags'

// POST /api/livestream/reservation
export const reserveLivestreamHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/livestream/reservation'>) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const body = await c.req.json<{
      tags: number[]
      title: string
      description: string
      playlist_url: string
      thumbnail_url: string
      start_at: number
      end_at: number
    }>()

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      // 2023/11/25 10:00からの１年間の期間内であるかチェック
      const termStartAt = Date.UTC(2023, 10, 25, 1)
      const termEndAt = Date.UTC(2024, 10, 25, 1)
      const reserveStartAt = body.start_at * 1000
      const reserveEndAt = body.end_at * 1000

      if (reserveStartAt >= termEndAt || reserveEndAt <= termStartAt) {
        await conn.rollback()
        return c.text('bad reservation time range', 400)
      }

      // 予約枠をみて、予約が可能か調べる
      // NOTE: 並列な予約のoverbooking防止にFOR UPDATEが必要
      const [slots] = await conn
        .query<(ReservationSlotsModel & RowDataPacket)[]>(
          'SELECT slot FROM reservation_slots WHERE start_at = ? AND end_at = ? FOR UPDATE',
          [body.start_at, body.end_at],
        )
        .catch((error) => {
          console.warn(`予約枠一覧取得でエラー発生: ${error}`)
          return throwErrorWith('failed to get reservation_slots')(error)
        })

      for (const slot of slots) {
        if (slot.slot < 1) {
          return c.text(
            `予約期間 ${Math.floor(termStartAt / 1000)} ~ ${Math.floor(
              termEndAt / 1000,
            )}に対して、予約区間 ${body.start_at} ~ ${
              body.end_at
            }が予約できません`,
            400,
          )
        }
      }

      let tagsJson = [];
      if (body.tags.length > 0) {
        tagsJson = body.tags.map((tagId) => {
          return {id: tagId, name: tagMaster()[tagId - 1]};
        });
      }

      await conn
        .query(
          'UPDATE reservation_slots SET slot = slot - 1 WHERE start_at = ? AND end_at = ?',
          [body.start_at, body.end_at],
        )
        .catch(throwErrorWith('failed to update reservation_slot'))
      const [{ insertId: livestreamId }] = await conn
        .query<ResultSetHeader>(
          'INSERT INTO livestreams (user_id, title, description, playlist_url, thumbnail_url, start_at, end_at, tags) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
          [
            userId,
            body.title,
            body.description,
            body.playlist_url,
            body.thumbnail_url,
            body.start_at,
            body.end_at,
            JSON.stringify(tagsJson),
          ],
        )
        .catch(throwErrorWith('failed to insert livestream'))

      const response = await fillLivestreamResponse(
        conn,
        {
          id: livestreamId,
          user_id: userId,
          title: body.title,
          description: body.description,
          playlist_url: body.playlist_url,
          thumbnail_url: body.thumbnail_url,
          start_at: body.start_at,
          end_at: body.end_at,
          tags: tagsJson,
        },
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill livestream'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(response, 201)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/livestream/search
export const searchLivestreamsHandler = async (
  c: Context<HonoEnvironment, '/api/livestream/search'>,
) => {
  const keyTagName = c.req.query('tag')

  const conn = await c.get('pool').getConnection()
  await conn.beginTransaction()

  try {
    const livestreams: (LivestreamsModel & RowDataPacket)[] = []

    interface LivestreamRelModel {
      id: number
      title: string
      description: string
      playlist_url: string
      thumbnail_url: string
      start_at: number
      end_at: number
      tags: {
        id: number,
        name: string
      }[]

      user_id: number
      user_name: string
      user_display_name: string
      user_description: string
      user_dark_mode: string
      user_image_hash: string
      
      icon_id?: number
      icon_image_hash?: string
    }

    if (keyTagName) {
      // タグによる取得
      const tagIds = [tagMaster().findIndex(tag => tag === keyTagName) + 1];
      const [results] = await conn
        .query<(LivestreamRelModel & RowDataPacket)[]>(
          `
          select
              livestreams.id,
              livestreams.title,
              livestreams.description,
              livestreams.playlist_url,
              livestreams.thumbnail_url,
              livestreams.start_at,
              livestreams.end_at,
              livestreams.tags,

              users.id as user_id,
              users.name as user_name,
              users.display_name as user_display_name,
              users.description as user_description,
              users.dark_mode as user_dark_mode,
              users.image_hash as user_image_hash
          from livestreams
          inner join users ON livestreams.user_id = users.id
          where ? MEMBER OF (tags->'$[*].id')
          ORDER BY livestreams.id DESC
          `,
          [tagIds[0]],
        )
        .catch(throwErrorWith('failed to get livestreams'))
      livestreams.push(...results)
    } else {
      // 検索条件なし
      let query = `
      select
          livestreams.id,
          livestreams.title,
          livestreams.description,
          livestreams.playlist_url,
          livestreams.thumbnail_url,
          livestreams.start_at,
          livestreams.end_at,
          livestreams.tags,

          users.id as user_id,
          users.name as user_name,
          users.display_name as user_display_name,
          users.description as user_description,
          users.dark_mode as user_dark_mode,
          users.image_hash as user_image_hash
      from livestreams
      inner join users ON livestreams.user_id = users.id
      ORDER BY livestreams.id DESC
      `;
      const limit = c.req.query('limit')
      if (limit) {
        const limitNumber = atoi(limit)
        if (limitNumber === false) {
          return c.text('limit query parameter must be integer', 400)
        }
        query += ` LIMIT ${limitNumber}`
      }

      const [results] = await conn
        .query<(LivestreamRelModel & RowDataPacket)[]>(query)
        .catch(throwErrorWith('failed to get livestreams'))

      livestreams.push(...results)
    }

    const livestreamResponses: LivestreamResponse[] = []
    for (const livestream of livestreams) {
      const userResponse = {
        id: livestream.user_id,
        name: livestream.user_name,
        display_name: livestream.user_display_name,
        description: livestream.user_description,
        theme: {
          id: livestream.user_id,
          dark_mode: !!livestream.user_dark_mode,
        },
        icon_hash: livestream.user_image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
      };

      const livestreamResponse = {
        id: livestream.id,
        owner: userResponse,
        title: livestream.title,
        tags: livestream.tags || [],
        description: livestream.description,
        playlist_url: livestream.playlist_url,
        thumbnail_url: livestream.thumbnail_url,
        start_at: livestream.start_at,
        end_at: livestream.end_at,
      }
      livestreamResponses.push(livestreamResponse)
    }

    await conn.commit().catch(throwErrorWith('failed to commit'))

    return c.json(livestreamResponses)
  } catch (error) {
    await conn.rollback()
    return c.text(`Internal Server Error\n${error}`, 500)
  } finally {
    await conn.rollback()
    conn.release()
  }
}

// GET /api/livestream
export const getMyLivestreamsHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/livestream'>) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const [livestreams] = await conn
        .query<(LivestreamsModel & RowDataPacket)[]>(
          'SELECT * FROM livestreams WHERE user_id = ?',
          [userId],
        )
        .catch(throwErrorWith('failed to get livestreams'))

      const livestreamResponses: LivestreamResponse[] = []
      for (const livestream of livestreams) {
        const livestreamResponse = await fillLivestreamResponse(
          conn,
          livestream,
          c.get('runtime').fallbackUserIcon,
        ).catch(throwErrorWith('failed to fill livestream'))

        livestreamResponses.push(livestreamResponse)
      }

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(livestreamResponses)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/user/:username/livestream
export const getUserLivestreamsHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/user/:username/livestream'>) => {
    const username = c.req.param('username')

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
        return c.text('user not found', 404)
      }

      const [livestreams] = await conn
        .query<(LivestreamsModel & RowDataPacket)[]>(
          'SELECT * FROM livestreams WHERE user_id = ?',
          [user.id],
        )
        .catch(throwErrorWith('failed to get livestreams'))

      const userResponse = {
        id: user.id,
        name: user.name,
        display_name: user.display_name,
        description: user.description,
        theme: {
          id: user.id,
          dark_mode: !!user.dark_mode,
        },
        icon_hash: user.image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
      };
      const livestreamResponses: LivestreamResponse[] = []
      for (const livestream of livestreams) {
        const livestreamResponse =  {
          id: livestream.id,
          owner: userResponse,
          title: livestream.title,
          tags: livestream.tags || [],
          description: livestream.description,
          playlist_url: livestream.playlist_url,
          thumbnail_url: livestream.thumbnail_url,
          start_at: livestream.start_at,
          end_at: livestream.end_at,
        }

        livestreamResponses.push(livestreamResponse)
      }

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(livestreamResponses)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// POST /api/livestream/:livestream_id/enter
export const enterLivestreamHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/enter'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      await conn
        .query(
          'INSERT INTO livestream_viewers_history (user_id, livestream_id, created_at) VALUES(?, ?, ?)',
          [userId, livestreamId, Date.now()],
        )
        .catch(throwErrorWith('failed to insert livestream_view_history'))

      await conn
        .query<ResultSetHeader>(
          'update users set viewers_count = viewers_count + 1 where id = (select user_id from livestreams where id = ?)',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      await conn
        .query<ResultSetHeader>(
          'update livestreams set viewers_count = viewers_count + 1 where id = ?',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      // eslint-disable-next-line unicorn/no-null
      return c.body(null)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// DELETE /api/livestream/:livestream_id/exit
export const exitLivestreamHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/exit'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      await conn
        .query(
          'DELETE FROM livestream_viewers_history WHERE user_id = ? AND livestream_id = ?',
          [userId, livestreamId],
        )
        .catch(throwErrorWith('failed to delete livestream_view_history'))

      await conn
        .query<ResultSetHeader>(
          'update users set viewers_count = viewers_count - 1 where id = (select user_id from livestreams where id = ?)',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      await conn
        .query<ResultSetHeader>(
          'update livestreams set viewers_count = viewers_count - 1 where id = ?',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to insert reaction'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      // eslint-disable-next-line unicorn/no-null
      return c.body(null)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/livestream/:livestream_id
export const getLivestreamHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/livestream/:livestream_id'>) => {
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const [[livestream]] = await conn
        .query<(LivestreamsModel & RowDataPacket)[]>(
          'SELECT * FROM livestreams WHERE id = ?',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to get livestream'))

      if (!livestream) {
        return c.text('not found livestream that has the given id', 404)
      }

      const livestreamResponse = await fillLivestreamResponse(
        conn,
        livestream,
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill livestream'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(livestreamResponse)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/livestream/:livestream_id/report
export const getLivecommentReportsHandler = [
  verifyUserSessionMiddleware,
  async (
    c: Context<HonoEnvironment, '/api/livestream/:livestream_id/report'>,
  ) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const livestreamId = atoi(c.req.param('livestream_id'))
    if (livestreamId === false) {
      return c.text('livestream_id in path must be integer', 400)
    }

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()
    try {
      const [[livestream]] = await conn
        .query<(LivestreamsModel & RowDataPacket)[]>(
          'SELECT * FROM livestreams WHERE id = ?',
          [livestreamId],
        )
        .catch(throwErrorWith('failed to get livestream'))

      const livestreamResponse = await fillLivestreamResponse(
        conn,
        livestream,
        c.get('runtime').fallbackUserIcon,
      )

      if (livestream.user_id !== userId) {
        return c.text("can't get other streamer's livecomment reports", 403)
      }

      interface LivecommentReportsRelModel {
        id: number,
        created_at: number,

        reporter_id: number
        reporter_name: string
        reporter_display_name: string
        reporter_description: string
        reporter_dark_mode: string
        reporter_image_hash: string

        comment_user_id: number
        comment_user_name: string
        comment_user_display_name: string
        comment_user_description: string
        comment_user_dark_mode: string
        comment_user_image_hash: string

        livecomment_id: number
        livecomment_comment: string
        livecomment_tip: number
        livecomment_created_at: number
      }
      

      const [livecommentReports] = await conn
        .query<(LivecommentReportsRelModel & RowDataPacket)[]>(
          `
          select
              livecomment_reports.id,
              livecomment_reports.created_at,

              reporter.name as reporter_name,
              reporter.display_name as reporter_display_name,
              reporter.description as reporter_description,
              reporter.dark_mode as reporter_dark_mode,
              reporter.image_hash as reporter_image_hash,
              
              comment_user.name as comment_user_name,
              comment_user.display_name as comment_user_display_name,
              comment_user.description as comment_user_description,
              comment_user.dark_mode as comment_user_dark_mode,
              comment_user.image_hash as comment_user_image_hash,

              livecomments.id as livecomment_id,
              livecomments.comment as livecomment_comment,
              livecomments.tip as livecomment_tip,
              livecomments.created_at as livecomment_created_at
          from livecomment_reports
          INNER join users as reporter ON reporter.id = livecomment_reports.user_id
          INNER join livecomments ON livecomments.id = livecomment_reports.livecomment_id
          INNER join users as comment_user ON comment_user.id = livecomments.user_id
          where livecomment_reports.livestream_id = ?
          `,
          [livestreamId],
        )
        .catch(throwErrorWith('failed to get livecomment reports'))

      const reportResponses: LivecommentReportResponse[] = []
      for (const livecommentReport of livecommentReports) {
        const reporterResponse = {
          id: livecommentReport.reporter_id,
          name: livecommentReport.reporter_name,
          display_name: livecommentReport.reporter_display_name,
          description: livecommentReport.reporter_description,
          theme: {
            id: livecommentReport.reporter_id,
            dark_mode: !!livecommentReport.reporter_dark_mode,
          },
          icon_hash: livecommentReport.reporter_image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
        };
        const commentUserResponse = {
          id: livecommentReport.comment_user_id,
          name: livecommentReport.comment_user_name,
          display_name: livecommentReport.comment_user_display_name,
          description: livecommentReport.comment_user_description,
          theme: {
            id: livecommentReport.comment_user_id,
            dark_mode: !!livecommentReport.comment_user_dark_mode,
          },
          icon_hash: livecommentReport.comment_user_image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
        };
        const livecommentResponse = {
          id: livecommentReport.livecomment_id,
          user: commentUserResponse,
          livestream: livestreamResponse,
          comment: livecommentReport.livecomment_comment,
          tip: livecommentReport.livecomment_tip,
          created_at: livecommentReport.livecomment_created_at,
        }
        const report = {
          id: livecommentReport.id,
          reporter: reporterResponse,
          livecomment: livecommentResponse,
          created_at: livecommentReport.created_at,
        }
        reportResponses.push(report)
      }

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(reportResponses)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]
