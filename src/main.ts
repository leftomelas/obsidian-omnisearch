import {
  App,
  Notice,
  Platform,
  Plugin,
  type PluginManifest,
  TFile,
} from 'obsidian'
import {
  OmnisearchInFileModal,
  OmnisearchVaultModal,
} from './components/modals'
import {
  getDefaultSettings,
  loadSettings,
  SettingsTab,
  showExcerpt,
} from './settings'
import type { OmnisearchSettings } from './settings/utils'
import { isCacheEnabled } from './settings/utils'
import { saveSettings } from './settings/utils'
import { isPluginDisabled } from './settings/utils'
import {
  eventBus,
  EventNames,
  indexingStep,
  IndexingStepType,
  type TextExtractorApi,
  type AIImageAnalyzerAPI,
} from './globals'
import { notifyOnIndexed, registerAPI } from './tools/api'
import { Database } from './database'
import { SearchEngine } from './search/search-engine'
import { DocumentsRepository } from './repositories/documents-repository'
import { logVerbose } from './tools/utils'
import { NotesIndexer } from './notes-indexer'
import { TextProcessor } from './tools/text-processing'
import { EmbedsRepository } from './repositories/embeds-repository'
import { SearchHistory } from './search/search-history'

export default class OmnisearchPlugin extends Plugin {
  // FIXME: fix the type
  public apiHttpServer: null | any = null
  public settings: OmnisearchSettings = getDefaultSettings(this.app)

  public readonly documentsRepository: DocumentsRepository
  public readonly embedsRepository = new EmbedsRepository(this)
  public readonly database = new Database(this)

  public readonly notesIndexer = new NotesIndexer(this)
  public readonly textProcessor = new TextProcessor(this)
  public readonly searchEngine = new SearchEngine(this)
  public readonly searchHistory = new SearchHistory(this)

  private ribbonButton?: HTMLElement
  private refreshIndexCallback?: (ev: FocusEvent) => any

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest)
    this.documentsRepository = new DocumentsRepository(this)
  }

  async onload(): Promise<void> {
    this.settings = await loadSettings(this)
    this.addSettingTab(new SettingsTab(this))

    if (!Platform.isMobile) {
      import('./tools/api-server').then(
        m => (this.apiHttpServer = m.getServer(this))
      )
    }

    if (isPluginDisabled(this.app)) {
      console.debug('Plugin disabled')
      return
    }

    await cleanOldCacheFiles(this.app)
    await this.database.clearOldDatabases()

    registerAPI(this)

    const settings = this.settings
    if (settings.ribbonIcon) {
      this.addRibbonButton()
    }

    eventBus.disable('vault')
    eventBus.disable('infile')
    eventBus.on('global', EventNames.ToggleExcerpts, () => {
      showExcerpt.set(!settings.showExcerpt)
    })

    // Commands to display Omnisearch modals
    this.addCommand({
      id: 'show-modal',
      name: 'Vault search',
      callback: () => {
        new OmnisearchVaultModal(this).open()
      },
    })

    this.addCommand({
      id: 'show-modal-infile',
      name: 'In-file search',
      editorCallback: (_editor, view) => {
        if (view.file) {
          new OmnisearchInFileModal(this, view.file).open()
        }
      },
    })

    const searchEngine = this.searchEngine

    this.app.workspace.onLayoutReady(async () => {
      // Listeners to keep the search index up-to-date
      this.registerEvent(
        this.app.vault.on('create', file => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            logVerbose('Indexing new file', file.path)
            searchEngine.addFromPaths([file.path])
            this.embedsRepository.refreshEmbedsForNote(file.path)
          }
        })
      )
      this.registerEvent(
        this.app.vault.on('delete', file => {
          if (!(file instanceof TFile)) return
          logVerbose('Removing file', file.path)
          this.documentsRepository.removeDocument(file.path)
          searchEngine.removeFromPaths([file.path])
          this.embedsRepository.removeFile(file.path)
        })
      )
      this.registerEvent(
        this.app.vault.on('modify', async file => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            this.notesIndexer.flagNoteForReindex(file)
          }
          this.embedsRepository.refreshEmbedsForNote(file.path)
        })
      )
      this.registerEvent(
        this.app.vault.on('rename', async (file, oldPath) => {
          if (!(file instanceof TFile)) return
          if (this.notesIndexer.isFileIndexable(file.path)) {
            logVerbose('Renaming file', file.path)
            this.documentsRepository.removeDocument(oldPath)
            await this.documentsRepository.addDocument(file.path)

            searchEngine.removeFromPaths([oldPath])
            await searchEngine.addFromPaths([file.path])

            this.embedsRepository.renameFile(oldPath, file.path)
          }
        })
      )

      this.refreshIndexCallback = this.notesIndexer.refreshIndex.bind(
        this.notesIndexer
      )
      addEventListener('blur', this.refreshIndexCallback!)
      removeEventListener

      await this.executeFirstLaunchTasks()
      await this.populateIndex()

      if (this.apiHttpServer && settings.httpApiEnabled) {
        this.apiHttpServer.listen(settings.httpApiPort)
      }
    })
  }

  async executeFirstLaunchTasks(): Promise<void> {
    const code = '1.21.0'
    // if (settings.welcomeMessage !== code && getTextExtractor()) {
    //   const welcome = new DocumentFragment()
    //   welcome.createSpan({}, span => {
    //     span.innerHTML = `🔎 Omnisearch can now index .docx and .xlsx documents. Don't forget to update Text Extractor and enable the toggle in Omnisearch settings.`
    //   })
    //   new Notice(welcome, 20_000)
    // }
    this.settings.welcomeMessage = code
    await this.saveData(this.settings)
  }

  async onunload(): Promise<void> {
    // @ts-ignore
    delete globalThis['omnisearch']

    if (this.refreshIndexCallback) {
      removeEventListener('blur', this.refreshIndexCallback)
    }

    // Clear cache when disabling Omnisearch
    if (process.env.NODE_ENV === 'production') {
      await this.database.clearCache()
    }
    this.apiHttpServer.close()
  }

  addRibbonButton(): void {
    this.ribbonButton = this.addRibbonIcon('search', 'Omnisearch', _evt => {
      new OmnisearchVaultModal(this).open()
    })
  }

  removeRibbonButton(): void {
    if (this.ribbonButton) {
      this.ribbonButton.parentNode?.removeChild(this.ribbonButton)
    }
  }

  /**
   * Plugin dependency - Chs Patch for Chinese word segmentation
   * @returns
   */
  public getChsSegmenter(): any | undefined {
    return (this.app as any).plugins.plugins['cm-chs-patch']
  }

  /**
   * Plugin dependency - Text Extractor
   * @returns
   */
  public getTextExtractor(): TextExtractorApi | undefined {
    return (this.app as any).plugins?.plugins?.['text-extractor']?.api
  }

  /**
   * Plugin dependency - Ai Image Analyzer
   * @returns
   */
  public getAIImageAnalyzer(): AIImageAnalyzerAPI | undefined {
    return (this.app as any).plugins?.plugins?.['ai-image-analyzer']?.api
  }

  private async populateIndex(): Promise<void> {
    console.time('Indexing total time')
    indexingStep.set(IndexingStepType.ReadingFiles)
    const files = this.app.vault
      .getFiles()
      .filter(f => this.notesIndexer.isFileIndexable(f.path))
    console.debug(`${files.length} files total`)
    console.debug(`Cache is ${isCacheEnabled() ? 'enabled' : 'disabled'}`)
    // Map documents in the background
    // Promise.all(files.map(f => cacheManager.addToLiveCache(f.path)))

    const searchEngine = this.searchEngine
    if (isCacheEnabled()) {
      console.time('Loading index from cache')
      indexingStep.set(IndexingStepType.LoadingCache)
      const hasCache = await searchEngine.loadCache()
      if (hasCache) {
        console.timeEnd('Loading index from cache')
      }
    }

    const diff = searchEngine.getDocumentsToReindex(
      files.map(f => ({ path: f.path, mtime: f.stat.mtime }))
    )

    if (isCacheEnabled()) {
      if (diff.toAdd.length) {
        console.debug(
          'Total number of files to add/update: ' + diff.toAdd.length
        )
      }
      if (diff.toRemove.length) {
        console.debug(
          'Total number of files to remove: ' + diff.toRemove.length
        )
      }
    }

    if (diff.toAdd.length >= 1000 && isCacheEnabled()) {
      new Notice(
        `${diff.toAdd.length} files need to be indexed. Obsidian may experience stutters and freezes during the process`,
        10_000
      )
    }

    indexingStep.set(IndexingStepType.IndexingFiles)
    searchEngine.removeFromPaths(diff.toRemove.map(o => o.path))
    await searchEngine.addFromPaths(diff.toAdd.map(o => o.path))

    if ((diff.toRemove.length || diff.toAdd.length) && isCacheEnabled()) {
      indexingStep.set(IndexingStepType.WritingCache)

      // Disable settings.useCache while writing the cache, in case it freezes
      const cacheEnabled = this.settings.useCache
      if (cacheEnabled && !this.settings.DANGER_forceSaveCache) {
        this.settings.useCache = false
        await saveSettings(this)
      }

      // Write the cache
      await this.database.writeMinisearchCache()
      await this.embedsRepository.writeToCache()

      // Re-enable settings.caching
      if (cacheEnabled) {
        this.settings.useCache = true
        await saveSettings(this)
      }
    }

    console.timeEnd('Indexing total time')
    if (diff.toAdd.length >= 1000 && isCacheEnabled()) {
      new Notice(`Your files have been indexed.`)
    }
    indexingStep.set(IndexingStepType.Done)
    notifyOnIndexed()
  }
}

/**
 * Read the files and feed them to Minisearch
 */

async function cleanOldCacheFiles(app: App) {
  const toDelete = [
    `${app.vault.configDir}/plugins/omnisearch/searchIndex.json`,
    `${app.vault.configDir}/plugins/omnisearch/notesCache.json`,
    `${app.vault.configDir}/plugins/omnisearch/notesCache.data`,
    `${app.vault.configDir}/plugins/omnisearch/searchIndex.data`,
    `${app.vault.configDir}/plugins/omnisearch/historyCache.json`,
    `${app.vault.configDir}/plugins/omnisearch/pdfCache.data`,
  ]
  for (const item of toDelete) {
    if (await app.vault.adapter.exists(item)) {
      try {
        await app.vault.adapter.remove(item)
      } catch (e) {}
    }
  }
}
