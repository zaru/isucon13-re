import { PoolConnection } from 'mysql2/promise'
import { UserModel } from '../types/models'

export interface UserResponse {
  id: number
  name: string
  display_name: string
  description: string
  theme: {
    id: number
    dark_mode: boolean
  }
  icon_hash: string
}

export const fillUserResponse = async (
  conn: PoolConnection,
  user: Omit<UserModel, 'password'>,
  getFallbackUserIcon: () => Promise<Readonly<ArrayBuffer>>,
) => {
  const imageHash = user?.image_hash || 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0'

  return {
    id: user.id,
    name: user.name,
    display_name: user.display_name,
    description: user.description,
    theme: {
      id: user.id,
      dark_mode: !!user.dark_mode,
    },
    icon_hash: imageHash,
  } satisfies UserResponse
}
