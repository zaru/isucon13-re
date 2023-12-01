import { PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  LivestreamsModel,
  UserModel,
} from '../types/models'
import { UserResponse, fillUserResponse } from './fill-user-response'

export interface LivestreamResponse {
  id: number
  owner: UserResponse
  title: string
  tags: { id: number; name: string }[]
  description: string
  playlist_url: string
  thumbnail_url: string
  start_at: number
  end_at: number
}

export const fillLivestreamResponse = async (
  conn: PoolConnection,
  livestream: LivestreamsModel,
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>,
  redis,
) => {
  let user = await redis.get(`user-${livestream.user_id}`);
  if (!user) {
    const [[userDb]] = await conn.query<(UserModel & RowDataPacket)[]>(
      'SELECT * FROM users WHERE id = ?',
      [livestream.user_id],
    )
    if (!userDb) throw new Error('not found user that has the given id')

    user = userDb;
    await redis.set(`user-${livestream.user_id}`, JSON.stringify({
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

  return {
    id: livestream.id,
    owner: userResponse,
    title: livestream.title,
    tags: livestream.tags || [],
    description: livestream.description,
    playlist_url: livestream.playlist_url,
    thumbnail_url: livestream.thumbnail_url,
    start_at: livestream.start_at,
    end_at: livestream.end_at,
  } satisfies LivestreamResponse
}
