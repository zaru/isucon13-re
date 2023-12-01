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
) => {
  const [[user]] = await conn.query<(UserModel & RowDataPacket)[]>(
    'SELECT * FROM users WHERE id = ?',
    [livestream.user_id],
  )
  if (!user) throw new Error('not found user that has the given id')

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
