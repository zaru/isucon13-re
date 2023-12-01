import { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { LivestreamsModel, ReactionsModel, UserModel } from '../types/models'
import {
  LivestreamResponse,
  fillLivestreamResponse,
} from './fill-livestream-response'
import { UserResponse, fillUserResponse } from './fill-user-response'

export interface ReactionResponse {
  id: number
  emoji_name: string
  user: UserResponse
  livestream: LivestreamResponse
  created_at: number
}

export const fillReactionResponse = async (
  conn: PoolConnection,
  reaction: ReactionsModel,
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>,
  redis,
) => {
  const [[user]] = await conn.query<(UserModel & RowDataPacket)[]>(
    'SELECT * FROM users WHERE id = ?',
    [reaction.user_id],
  )
  if (!user) throw new Error('not found user that has the given id')

  const userResponse = await fillUserResponse(conn, user, getFallbackUserIcon)

  let livestream = await redis.get(`livestream-${reaction.livestream_id}`);
  if (!livestream) {
    const [[livestreamDb]] = await conn.query<(LivestreamsModel & RowDataPacket)[]>(
      'SELECT * FROM livestreams WHERE id = ?',
      [reaction.livestream_id],
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
    id: reaction.id,
    emoji_name: reaction.emoji_name,
    user: userResponse,
    livestream: livestreamResponse,
    created_at: reaction.created_at,
  } satisfies ReactionResponse
}
