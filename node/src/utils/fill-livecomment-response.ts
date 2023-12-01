import { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { LivecommentsModel, LivestreamsModel, UserModel } from '../types/models'
import { UserResponse, fillUserResponse } from './fill-user-response'
import {
  LivestreamResponse,
  fillLivestreamResponse,
} from './fill-livestream-response'

export interface LivecommentResponse {
  id: number
  user: UserResponse
  livestream: LivestreamResponse
  comment: string
  tip: number
  created_at: number
}

export const fillLivecommentResponse = async (
  conn: PoolConnection,
  livecomment: LivecommentsModel,
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>,
  redis,
) => {

  let user = await redis.get(`user-${livecomment.user_id}`);
  if (!user) {
    const [[userDb]] = await conn.query<(UserModel & RowDataPacket)[]>(
      'SELECT * FROM users WHERE id = ?',
      [livecomment.user_id],
    )
    if (!userDb) throw new Error('not found user that has the given id')

    user = userDb;
    await redis.set(`user-${livecomment.user_id}`, JSON.stringify({
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
    // await redis.hmset(`user-${livecomment.user_id}`, {
    //   id: userDb.id,
    //   name: userDb.name,
    //   display_name: userDb.display_name,
    //   password: userDb.password,
    //   description: userDb.description,
    //   score: userDb.score,
    //   viewers_count: userDb.viewers_count,
    //   total_reactions: userDb.total_reactions,
    //   total_livecomments: userDb.total_livecomments,
    //   total_tip: userDb.total_tip,
    //   dark_mode: userDb.dark_mode,
    //   image_hash: userDb.image_hash,
    // })
  } else {
    user = JSON.parse(user);
  }

  const userResponse = await fillUserResponse(conn, user, getFallbackUserIcon)

  let livestream = await redis.get(`livestream-${livecomment.livestream_id}`);
  if (!livestream) {
    const [[livestreamDb]] = await conn.query<(LivestreamsModel & RowDataPacket)[]>(
      'SELECT * FROM livestreams WHERE id = ?',
      [livecomment.livestream_id],
    )
    if (!livestreamDb) {
      throw new Error('not found livestream that has the given id')
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
  const livestreamResponse = await fillLivestreamResponse(
    conn,
    livestream,
    getFallbackUserIcon,
    redis,
  )

  return {
    id: livecomment.id,
    user: userResponse,
    livestream: livestreamResponse,
    comment: livecomment.comment,
    tip: livecomment.tip,
    created_at: livecomment.created_at,
  } satisfies LivecommentResponse
}
