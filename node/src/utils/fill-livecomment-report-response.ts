import { PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  LivecommentReportsModel,
  LivecommentsModel,
  UserModel,
} from '../types/models'
import { UserResponse, fillUserResponse } from './fill-user-response'
import {
  LivecommentResponse,
  fillLivecommentResponse,
} from './fill-livecomment-response'

export interface LivecommentReportResponse {
  id: number
  reporter: UserResponse
  livecomment: LivecommentResponse
  created_at: number
}

export const fillLivecommentReportResponse = async (
  conn: PoolConnection,
  livecommentReport: LivecommentReportsModel,
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>,
  redis,
) => {
  let user = await redis.get(`user-${livecommentReport.user_id}`);
  if (!user) {
    const [[userDb]] = await conn.query<(UserModel & RowDataPacket)[]>(
      'SELECT * FROM users WHERE id = ?',
      [livecommentReport.user_id],
    )
    if (!userDb) throw new Error('not found user that has the given id')

    user = userDb;
    await redis.set(`user-${livecommentReport.user_id}`, JSON.stringify({
      id: userDb.id,
      name: userDb.name,
      display_name: userDb.display_name,
      password: userDb.password,
      description: userDb.description,
      score: userDb.score,
      viewers_count: userDb.viewers_count,
      total_reactions: userDb.total_reactions,
      total_livecomments: userDb.total_livecomments,
      total_tip: userDb.total_tip,
      dark_mode: userDb.dark_mode,
      image_hash: userDb.image_hash,
    }))
  } else {
    user = JSON.parse(user);
  }
  
  const userResponse = await fillUserResponse(conn, user, getFallbackUserIcon)

  const [[livecomment]] = await conn.query<
    (LivecommentsModel & RowDataPacket)[]
  >('SELECT * FROM livecomments WHERE id = ?', [
    livecommentReport.livecomment_id,
  ])
  if (!livecomment)
    throw new Error('not found livecomment that has the given id')

  const livecommentResponse = await fillLivecommentResponse(
    conn,
    livecomment,
    getFallbackUserIcon,
    redis,
  )

  return {
    id: livecommentReport.id,
    reporter: userResponse,
    livecomment: livecommentResponse,
    created_at: livecommentReport.created_at,
  } satisfies LivecommentReportResponse
}
