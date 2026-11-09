import { afterAll } from 'vitest'
import { cleanupTemp } from './harness'

afterAll(() => cleanupTemp())
