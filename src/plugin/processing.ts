import fs from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import { millify } from 'millify'
import pc from 'picocolors'
import { approximateTokenSize } from 'tokenx'
import TurndownService from 'turndown'
import { defaultLLMsTxtTemplate } from '@/constants'
import { generateLLMsFullTxt } from '@/generator/llms-full-txt'
import { generateLLMsTxt } from '@/generator/llms-txt'
import { generateLLMFriendlyPages } from '@/generator/page-generator'
import type { PreparedFile, VitePressConfig } from '@/internal-types'
import type { CustomTemplateVariables, LlmstxtSettings } from '@/types.d'
import { getDirectoriesAtDepths } from '@/utils/file-utils'
import { getHumanReadableSizeOf } from '@/utils/helpers'
import log from '@/utils/logger'
import { extractTitle } from '@/utils/markdown'
import { expandTemplate } from '@/utils/template-utils'
import { resolveSourceFilePath } from '@/utils/vitepress-rewrites'

export async function processPages(
	pageContents: Map<string, string>,
	settings: LlmstxtSettings & { ignoreFiles: string[]; workDir: string },
	config: VitePressConfig,
	isSsrBuild: boolean,
): Promise<void> {
	if (isSsrBuild) {
		log.info('Skipping LLMs docs generation in SSR build')
		return
	}

	const outDir = config.vitepress?.outDir ?? 'dist'
	const turndownService = new TurndownService({ headingStyle: 'atx' })

	try {
		await fs.access(outDir)
	} catch {
		log.info(`Creating output directory: ${pc.cyan(outDir)}`)
		await fs.mkdir(outDir, { recursive: true })
	}

	if (pageContents.size === 0) {
		log.warn('No pages found to process.')
		return
	}

	log.info(`Processing ${pc.bold(pageContents.size.toString())} pages.`)

	const preparedFiles: PreparedFile[] = []

	for (const [filePath, html] of pageContents.entries()) {
		const markdown = turndownService.turndown(html)
		const processedMarkdown = matter(markdown)
		const title = extractTitle(processedMarkdown)?.trim() || 'Untitled'

		const normalizedPath =
			path.basename(filePath) === 'index.md' && path.dirname(filePath) !== '.' && path.dirname(filePath) !== ''
				? `${path.dirname(filePath)}.md`
				: filePath

		preparedFiles.push({
			path: normalizedPath,
			title,
			file: processedMarkdown,
		})
	}

	preparedFiles.sort((a, b) => a.title.localeCompare(b.title))

	const tasks: Promise<void>[] = []
	const mdFilesList = Array.from(pageContents.keys())

	if (settings.generateLLMsTxt) {
		const templateVariables: CustomTemplateVariables = {
			title: settings.title,
			description: settings.description,
			details: settings.details,
			toc: settings.toc,
			...settings.customTemplateVariables,
		}

		const directories = getDirectoriesAtDepths(
			mdFilesList,
			settings.workDir,
			settings.experimental?.depth ?? 1,
		)

		tasks.push(
			...directories.map((directory) =>
				(async () => {
					const isRoot = directory.relativePath === '.'
					const directoryFilter = isRoot ? '.' : directory.relativePath
					const outputFileName = isRoot ? 'llms.txt' : path.join(directory.relativePath, 'llms.txt')
					const llmsTxtPath = path.resolve(outDir, outputFileName)

					await fs.mkdir(path.dirname(llmsTxtPath), { recursive: true })
					log.info(`Generating ${pc.cyan(outputFileName)}...`)

					const llmsTxt = await generateLLMsTxt(preparedFiles, {
						indexMd: path.resolve(
							settings.workDir,
							resolveSourceFilePath('index.md', settings.workDir, config.vitepress.userConfig?.rewrites),
						),
						outDir: settings.workDir,
						LLMsTxtTemplate: settings.customLLMsTxtTemplate || defaultLLMsTxtTemplate,
						templateVariables,
						vitepressConfig: config?.vitepress?.userConfig,
						domain: settings.domain,
						sidebar: config?.vitepress?.userConfig?.themeConfig?.sidebar,
						linksExtension: !settings.generateLLMFriendlyDocsForEachPage ? '.html' : undefined,
						base: config.base,
						directoryFilter,
					})

					await fs.writeFile(llmsTxtPath, llmsTxt, 'utf-8')
					log.success(
						expandTemplate(
							'Generated {file} (~{tokens} tokens, {size}) with {fileCount} documentation links',
							{
								file: pc.cyan(outputFileName),
								tokens: pc.bold(millify(approximateTokenSize(llmsTxt))),
								size: pc.bold(getHumanReadableSizeOf(llmsTxt)),
								fileCount: pc.bold(pageContents.size.toString()),
							},
						),
					)
				})(),
			),
		)
	}

	if (settings.generateLLMsFullTxt) {
		const directories = getDirectoriesAtDepths(
			mdFilesList,
			settings.workDir,
			settings.experimental?.depth ?? 1,
		)

		tasks.push(
			...directories.map((directory) =>
				(async () => {
					const isRoot = directory.relativePath === '.'
					const directoryFilter = isRoot ? '.' : directory.relativePath
					const outputFileName = isRoot ? 'llms-full.txt' : path.join(directory.relativePath, 'llms-full.txt')
					const llmsFullTxtPath = path.resolve(outDir, outputFileName)

					await fs.mkdir(path.dirname(llmsFullTxtPath), { recursive: true })
					log.info(`Generating full documentation bundle (${pc.cyan(outputFileName)})...`)

					const llmsFullTxt = await generateLLMsFullTxt(preparedFiles, {
						domain: settings.domain,
						linksExtension: !settings.generateLLMFriendlyDocsForEachPage ? '.html' : undefined,
						base: config.base,
						directoryFilter,
					})

					await fs.writeFile(llmsFullTxtPath, llmsFullTxt, 'utf-8')
					log.success(
						expandTemplate('Generated {file} (~{tokens} tokens, {size}) with {fileCount} markdown files', {
							file: pc.cyan(outputFileName),
							tokens: pc.bold(millify(approximateTokenSize(llmsFullTxt))),
							size: pc.bold(getHumanReadableSizeOf(llmsFullTxt)),
							fileCount: pc.bold(pageContents.size.toString()),
						}),
					)
				})(),
			),
		)
	}

	if (settings.generateLLMFriendlyDocsForEachPage) {
		tasks.push(generateLLMFriendlyPages(preparedFiles, outDir, settings.domain, config.base))
	}

	if (tasks.length) {
		await Promise.all(tasks)
	}
}
