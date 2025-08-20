import path from 'node:path'
import pc from 'picocolors'
import type { Plugin, ViteDevServer } from 'vite'
import { name as packageName } from '@/../package.json'
import { unnecessaryFilesList } from '@/constants'
import type { VitePressConfig } from '@/internal-types'
import { configureDevServer } from '@/plugin/dev-server'
import { processPages } from '@/plugin/processing'
import type { LlmstxtSettings } from '@/types'
import log from '@/utils/logger'

const PLUGIN_NAME = packageName

//#region Plugin
/**
 * [VitePress](http://vitepress.dev/) plugin for generating raw documentation
 * for **LLMs** in Markdown format which is much lighter and more efficient for LLMs
 *
 * @param [userSettings={}] - Plugin settings.
 *
 * @see https://github.com/okineadev/vitepress-plugin-llms
 * @see https://llmstxt.org/
 */
export function llmstxt(userSettings: LlmstxtSettings = {}): Plugin {
	// Create a settings object with defaults explicitly merged
	const settings: Omit<LlmstxtSettings, 'ignoreFiles' | 'workDir'> & {
		ignoreFiles: string[]
		workDir: string
	} = {
		generateLLMsTxt: true,
		generateLLMsFullTxt: true,
		generateLLMFriendlyDocsForEachPage: true,
		ignoreFiles: [],
		excludeUnnecessaryFiles: true,
		excludeIndexPage: true,
		excludeBlog: true,
		excludeTeam: true,
		injectLLMHint: true,
		workDir: undefined as unknown as string,
		stripHTML: true,
		experimental: {
			depth: 1,
			...userSettings.experimental,
		},
		...userSettings,
	}

	// Store the resolved Vite config
	let config: VitePressConfig

	// Map to store final page HTML content
	const pageContents = new Map<string, string>()

	// Flag to identify which build we're in
	let isSsrBuild = false

	return {
		name: PLUGIN_NAME,
		// Run after all other plugins
		enforce: 'post',

		/** Resolves the Vite configuration and sets up the working directory. */
		configResolved(resolvedConfig) {
			config = resolvedConfig as VitePressConfig
			if (settings.workDir) {
				settings.workDir = path.resolve(config.vitepress.srcDir, settings.workDir)
			} else {
				settings.workDir = path.resolve(config.vitepress.srcDir)
			}

			if (settings.excludeUnnecessaryFiles) {
				settings.excludeIndexPage && settings.ignoreFiles.push(...unnecessaryFilesList.indexPage)
				settings.excludeBlog && settings.ignoreFiles.push(...unnecessaryFilesList.blogs)
				settings.excludeTeam && settings.ignoreFiles.push(...unnecessaryFilesList.team)
			}

			// Detect if this is the SSR build
			isSsrBuild = !!resolvedConfig.build?.ssr

			log.info(
				`${pc.bold(PLUGIN_NAME)} initialized ${isSsrBuild ? pc.dim('(SSR build)') : pc.dim('(client build)')} with workDir: ${pc.cyan(settings.workDir)}`,
			)

			// Inject Vitepress hooks
			const vitepressConfig = config.vitepress
			if (vitepressConfig) {
				const originalTransformHtml = vitepressConfig.transformHtml
				vitepressConfig.transformHtml = (code, id, { pageData }) => {
					if (!isSsrBuild) {
						// pageData.relativePath is the path to the page, e.g., 'index.md' or 'guide/getting-started.md'
						// We use this as a key to store the final HTML content.
						pageContents.set(pageData.relativePath, code)
					}
					if (originalTransformHtml) {
						return originalTransformHtml(code, id, { pageData })
					}
				}

				const originalBuildEnd = vitepressConfig.buildEnd
				vitepressConfig.buildEnd = async (siteConfig) => {
					if (!isSsrBuild) {
						await processPages(pageContents, settings, config, isSsrBuild)
					}
					if (originalBuildEnd) {
						await originalBuildEnd(siteConfig)
					}
				}
			}
		},

		/** Configures the development server to handle `llms.txt` and markdown files for LLMs. */
		async configureServer(server: ViteDevServer) {
			await configureDevServer(server, config)
		},

		buildStart() {
			pageContents.clear()
		},
	}
}

export default llmstxt

//#endregion
