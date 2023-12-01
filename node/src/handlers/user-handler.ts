import { Context } from 'hono'
import { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { HonoEnvironment } from '../types/application'
import {
  defaultUserIDKey,
  defaultUserNameKey,
  defaultSessionExpiresKey,
} from '../contants'
import { verifyUserSessionMiddleware } from '../middlewares/verify-user-session-middleare'
import { fillUserResponse } from '../utils/fill-user-response'
import { throwErrorWith } from '../utils/throw-error-with'
import { IconModel, UserModel } from '../types/models'
import crypto from 'crypto'
const fs = require('fs');


// GET /api/user/:username/icon
export const getIconHandler = [
  async (c: Context<HonoEnvironment, '/api/user/:username/icon'>) => {
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
        await conn.rollback()
        return c.text('not found user that has the given username', 404)
      }

      const [[icon]] = await conn
        .query<(Pick<IconModel, 'image_hash'> & RowDataPacket)[]>(
          'SELECT image_hash FROM icons WHERE user_id = ?',
          [user.id],
        )
        .catch(throwErrorWith('failed to get icon'))
      if (!icon) {
        await conn.rollback()
        return c.body(await c.get('runtime').fallbackUserIcon(), 200, {
          'Content-Type': 'image/jpeg',
        })
      }
      
      const reqHash = c.req.header('If-None-Match');

      if (reqHash === `"${icon.image_hash}"`) {
        return c.body(null, 304);
      }

      const [[icon2]] = await conn
        .query<(Pick<IconModel, 'image'> & RowDataPacket)[]>(
          'SELECT image FROM icons WHERE user_id = ?',
          [user.id],
        )
        .catch(throwErrorWith('failed to get icon'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.body(icon2.image, 200, {
        'Content-Type': 'image/jpeg',
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

// POST /api/icon
export const postIconHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/icon'>) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware
    const userName = c.get('session').get(defaultUserNameKey) as number // userId is verified by verifyUserSessionMiddleware

    // base64 encoded image
    const body = await c.req.json<{ image: string }>()

    const conn = await c.get('pool').getConnection()
    const redis = c.get('clientRedis');
    await conn.beginTransaction()

    try {
      const buffer = Buffer.from(body.image, 'base64');

      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      fs.writeFile(`/home/isucon/webapp/public/images/${userName}.jpg`, buffer, (err) => {
        if (err) {
          console.error('エラーが発生しました:', err);
        } else {
          console.log('ファイルが正常に保存されました。');
        }
      });
      fs.writeFile(`/home/isucon/webapp/public/images/"${hash}".jpg`, buffer, (err) => {
        if (err) {
          console.error('エラーが発生しました:', err);
        } else {
          console.log('ファイルが正常に保存されました。');
        }
      });

      const [{ insertId: iconId }] = await conn
        .query<ResultSetHeader>(
          'update users set image_hash = ? where id = ?',
          [hash, userId],
        )
        .catch(throwErrorWith('failed to insert icon'))

      const userRedis = JSON.parse(await redis.get(`user-${userId}`))
      userRedis.image_hash = hash
      redis.set(`user-${userId}`, JSON.stringify(userRedis))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json({ id: userId }, 201)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// GET /api/user/me
export const getMeHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/user/me'>) => {
    const userId = c.get('session').get(defaultUserIDKey) as number // userId is verified by verifyUserSessionMiddleware

    const conn = await c.get('pool').getConnection()
    await conn.beginTransaction()

    try {
      const [[user]] = await conn
        .query<(UserModel & RowDataPacket)[]>(
          'SELECT * FROM users WHERE id = ?',
          [userId],
        )
        .catch(throwErrorWith('failed to get user'))

      if (!user) {
        await conn.rollback()
        return c.text('not found user that has the userid in session', 404)
      }

      const response = await fillUserResponse(
        conn,
        user,
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill user'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(response)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]

// ユーザ登録API
// POST /api/register
export const registerHandler = async (
  c: Context<HonoEnvironment, '/api/register'>,
) => {
  const body = await c.req.json<{
    name: string
    display_name: string
    description: string
    password: string
    theme: { dark_mode: boolean }
  }>()

  if (body.name === 'pipe') {
    return c.text("the username 'pipe' is reserved", 400)
  }

  const hashedPassword = await c
    .get('runtime')
    .hashPassword(body.password)
    .catch(throwErrorWith('failed to generate hashed password'))

  const conn = await c.get('pool').getConnection()
  const redis = await c.get('clientRedis')
  await conn.beginTransaction()

  try {
    const [{ insertId: userId }] = await conn
      .execute<ResultSetHeader>(
        'INSERT INTO users (name, display_name, description, password, dark_mode) VALUES(?, ?, ?, ?, ?)',
        [body.name, body.display_name, body.description, hashedPassword, body.theme.dark_mode],
      )
      .catch(throwErrorWith('failed to insert user'))

    await redis.set(`user-${userId}`, JSON.stringify({
      id: userId,
      name: body.name,
      display_name: body.display_name,
      password: hashedPassword,
      description: body.description,
      score: 0,
      viewers_count: 0,
      total_reactions: 0,
      total_livecomments: 0,
      total_tip: 0,
      dark_mode: body.dark_mode,
      image_hash: null,
    }))

    await c
      .get('runtime')
      .exec([
        'pdnsutil',
        'add-record',
        'u.isucon.dev',
        body.name,
        'A',
        '86400',
        c.get('runtime').powerDNSSubdomainAddress,
      ])
      .catch(throwErrorWith('failed to add record to powerdns'))

    const response = {
      id: userId,
      name: body.name,
      display_name: body.display_name,
      description: body.description,
      theme: {
        id: userId,
        dark_mode: !!body.theme.dark_mode,
      },
      icon_hash: 'd9f8294e9d895f81ce62e73dc7d5dff862a4fa40bd4e0fecf53f7526a8edcac0',
    };

    await conn.commit().catch(throwErrorWith('failed to commit'))

    return c.json(response, 201)
  } catch (error) {
    await conn.rollback()
    return c.text(`Internal Server Error\n${error}`, 500)
  } finally {
    await conn.rollback()
    conn.release()
  }
}

// ユーザログインAPI
// POST /api/login
export const loginHandler = async (
  c: Context<HonoEnvironment, '/api/login'>,
) => {
  const body = await c.req.json<{
    username: string
    password: string
  }>()

  const conn = await c.get('pool').getConnection()
  await conn.beginTransaction()

  try {
    // usernameはUNIQUEなので、whereで一意に特定できる
    const [[user]] = await conn
      .query<(UserModel & RowDataPacket)[]>(
        'SELECT * FROM users WHERE name = ?',
        [body.username],
      )
      .catch(throwErrorWith('failed to get user'))

    if (!user) {
      await conn.rollback()
      return c.text('invalid username or password', 401)
    }

    await conn.commit().catch(throwErrorWith('failed to commit'))

    const isPasswordMatch = await c
      .get('runtime')
      .comparePassword(body.password, user.password)
      .catch(throwErrorWith('failed to compare hash and password'))
    if (!isPasswordMatch) {
      return c.text('invalid username or password', 401)
    }

    // 1時間でセッションが切れるようにする
    const sessionEndAt = Date.now() + 1000 * 60 * 60

    const session = c.get('session')
    session.set(defaultUserIDKey, user.id)
    session.set(defaultUserNameKey, user.name)
    session.set(defaultSessionExpiresKey, sessionEndAt)

    // eslint-disable-next-line unicorn/no-null
    return c.body(null)
  } catch (error) {
    await conn.rollback()
    return c.text(`Internal Server Error\n${error}`, 500)
  } finally {
    await conn.rollback()
    conn.release()
  }
}

// GET /api/user/:username
export const getUserHandler = [
  verifyUserSessionMiddleware,
  async (c: Context<HonoEnvironment, '/api/user/:username'>) => {
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
        await conn.rollback()
        return c.text('not found user that has the given username', 404)
      }

      const response = await fillUserResponse(
        conn,
        user,
        c.get('runtime').fallbackUserIcon,
      ).catch(throwErrorWith('failed to fill user'))

      await conn.commit().catch(throwErrorWith('failed to commit'))

      return c.json(response)
    } catch (error) {
      await conn.rollback()
      return c.text(`Internal Server Error\n${error}`, 500)
    } finally {
      await conn.rollback()
      conn.release()
    }
  },
]
