import { jest } from '@jest/globals'

// The @actions/github module exposes `context` (an object) and `getOctokit`
// (a factory). For tests we want to mutate context per-test and stub the
// octokit factory, so we expose plain mutable objects rather than jest.fn()
// wrappers around the real types.

// A minimal Octokit shape that matches CompareCapableOctokit in main.ts.
// Tests can swap `compareCommitsWithBasehead` per scenario.
export const compareCommitsWithBasehead =
  jest.fn<
    (params: {
      owner: string
      repo: string
      basehead: string
      per_page?: number
      page?: number
    }) => Promise<{ data: { files?: Array<{ filename: string }> } }>
  >()

export const getOctokit = jest.fn(() => ({
  rest: {
    repos: {
      compareCommitsWithBasehead
    }
  }
}))

// `context` is mutated per test (eventName, payload, repo). Reset in
// beforeEach to a known baseline so tests don't bleed into each other.
export const context: {
  eventName: string
  payload: Record<string, unknown>
  repo: { owner: string; repo: string }
} = {
  eventName: '',
  payload: {},
  repo: { owner: 'test-owner', repo: 'test-repo' }
}
