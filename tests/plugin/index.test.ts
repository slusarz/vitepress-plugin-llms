// spell-checker:words awesomeproject myproject otherdocs

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ViteDevServer } from 'vite'
import type { Plugin } from 'vitepress'
import mockedFs from '../mocks/fs'
import mockedLogger from '../mocks/utils/logger'

import fakeMarkdownDocument from '../test-assets/markdown-document.md' with { type: 'text' }

const { access, mkdir, writeFile, readFile } = mockedFs.default

mock.module('node:fs/promises', () => mockedFs)

// Mock the logger to prevent logs in tests
mock.module('@/utils/logger', () => mockedLogger)

import path from 'node:path'
import type { VitePressConfig } from '@/internal-types'
// Import the module under test AFTER mocking its dependencies
// @ts-ignore
import { llmstxt } from '@/plugin/plugin'

describe('llmstxt plugin', () => {
	let plugin: Plugin
	let mockConfig: VitePressConfig
	let mockServer: ViteDevServer

	beforeEach(() => {
		// Reset mock call counts
		access.mockReset()
		mkdir.mockReset()
		writeFile.mockReset()
		readFile.mockReturnValue(Promise.resolve(fakeMarkdownDocument))

		// Setup mock config
		mockConfig = {
			root: path.resolve('docs'),
			vitepress: {
				outDir: path.resolve('dist'),
				srcDir: path.resolve('docs'),
				userConfig: {
					// @ts-ignore
					rewrites: {},
				},
			},
			build: {
				ssr: false,
			},
		} as VitePressConfig

		// Setup mock server
		mockServer = {
			middlewares: {
				use: mock(),
			},
		} as unknown as ViteDevServer
	})

	afterEach(() => {
		readFile.mockReset()
	})

	describe('buildEnd processing', () => {
		it('should skip processing in SSR build', async () => {
			const ssrConfig = { ...mockConfig, build: { ssr: true } }
			plugin = llmstxt()
			// @ts-ignore
			plugin.configResolved(ssrConfig)
			// @ts-ignore
			await mockConfig.vitepress.buildEnd()
			expect(writeFile).not.toHaveBeenCalled()
		})

		it('should create output directory if it does not exist', async () => {
			access.mockImplementationOnce(async () => {
				throw new Error()
			})

			plugin = llmstxt()
			// @ts-ignore
			plugin.configResolved(mockConfig)
			// @ts-ignore
			await mockConfig.vitepress.buildEnd()

			expect(mkdir).toHaveBeenCalledWith(path.resolve('dist'), { recursive: true })
		})

		it('should process pages and generate output files', async () => {
			plugin = llmstxt({ generateLLMsFullTxt: false, generateLLMsTxt: false })

			// @ts-ignore
			plugin.configResolved(mockConfig)
			// @ts-ignore
			plugin.buildStart()

			const pageContents = new Map<string, string>()
			pageContents.set('test.md', '<h1>Test Page</h1>')
			pageContents.set('guide/index.md', '<h1>Guide</h1>')

			// Simulate transformHtml
			for (const [key, value] of pageContents.entries()) {
				// @ts-ignore
				mockConfig.vitepress.transformHtml(value, '', { pageData: { relativePath: key } })
			}

			// @ts-ignore
			await mockConfig.vitepress.buildEnd()

			// Verify that files were written
			const calls = writeFile.mock.calls
			expect(calls.length).toBe(2)

			// Note: files are sorted by title before processing, so "Guide" comes before "Test Page"
			const guideCall = calls.find((call) => (call[0] as string).endsWith('guide.md'))
			const testCall = calls.find((call) => (call[0] as string).endsWith('test.md'))

			expect(guideCall).toBeDefined()
			expect(testCall).toBeDefined()

			// Check the call for guide.md
			expect(guideCall![0]).toBe(path.resolve(mockConfig.vitepress.outDir, 'guide.md'))
			expect(guideCall![1]).toContain('# Guide')

			// Check the call for test.md
			expect(testCall![0]).toBe(path.resolve(mockConfig.vitepress.outDir, 'test.md'))
			expect(testCall![1]).toContain('# Test Page')
		})
	})
})
