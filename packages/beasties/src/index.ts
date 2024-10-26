/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import type { ChildNode, Node } from 'domhandler'

import type { HTMLDocument } from './dom'
import type { Logger, Options } from './types'

import { readFile } from 'node:fs'
import path from 'node:path'

import { applyMarkedSelectors, markOnly, parseStylesheet, serializeStylesheet, validateMediaQuery, walkStyleRules, walkStyleRulesWithReverseMirror } from './css'
import { createDocument, serializeDocument } from './dom'
import { createLogger, isSubpath } from './util'

export default class Beasties {
  options: Options & Required<Pick<Options, 'logLevel' | 'path' | 'publicPath' | 'reduceInlineStyles' | 'pruneSource' | 'additionalStylesheets'>> & { allowRules: Array<string | RegExp> }
  logger: Logger
  fs?: typeof import('node:fs')
  // TODO: remove (undocumented) support
  urlFilter: (url: string) => boolean

  constructor(options: Options = {}) {
    this.options = Object.assign({
      logLevel: 'info',
      path: '',
      publicPath: '',
      reduceInlineStyles: true,
      pruneSource: false,
      additionalStylesheets: [],
      allowRules: [],
    }, options)

    // @ts-expect-error TODO: remove support
    this.urlFilter = this.options.filter
    if (this.urlFilter instanceof RegExp) {
      this.urlFilter = this.urlFilter.test.bind(this.urlFilter)
    }

    this.logger = this.options.logger || createLogger(this.options.logLevel)
  }

  /**
   * Read the contents of a file from the specified filesystem or disk
   */
  readFile(filename: string): string | Promise<string> {
    const fs = this.fs
    return new Promise<string>((resolve, reject) => {
      // eslint-disable-next-line node/prefer-global/buffer
      const callback = (err: NodeJS.ErrnoException | null, data: string | Buffer) => {
        if (err)
          reject(err)
        else resolve(data.toString())
      }
      if (fs && fs.readFile) {
        fs.readFile(filename, callback)
      }
      else {
        readFile(filename, 'utf-8', callback)
      }
    })
  }

  /**
   * Apply critical CSS processing to the html
   */
  async process(html: string) {
    const start = Date.now()

    // Parse the generated HTML in a DOM we can mutate
    const document = createDocument(html)

    if (this.options.additionalStylesheets.length > 0) {
      this.embedAdditionalStylesheet(document)
    }

    // `external:false` skips processing of external sheets
    if (this.options.external !== false) {
      const externalSheets = ([] as ChildNode[]).slice.call(
        document.querySelectorAll('link[rel="stylesheet"]'),
      )

      await Promise.all(
        externalSheets.map(link => this.embedLinkedStylesheet(link, document)),
      )
    }

    // go through all the style tags in the document and reduce them to only critical CSS
    const styles = this.getAffectedStyleTags(document)

    await Promise.all(
      styles.map(style => this.processStyle(style, document)),
    )

    if (this.options.mergeStylesheets !== false && styles.length !== 0) {
      await this.mergeStylesheets(document)
    }

    // serialize the document back to HTML and we're done
    const output = serializeDocument(document)
    const end = Date.now()
    this.logger.info?.(`Time ${end - start}ms`)
    return output
  }

  /**
   * Get the style tags that need processing
   */
  getAffectedStyleTags(document: HTMLDocument) {
    const styles = [...document.querySelectorAll('style')]

    // `inline:false` skips processing of inline stylesheets
    if (this.options.reduceInlineStyles === false) {
      return styles.filter(style => style.$$external)
    }
    return styles
  }

  async mergeStylesheets(document: HTMLDocument) {
    const styles = this.getAffectedStyleTags(document)
    if (styles.length === 0) {
      this.logger.warn?.(
        'Merging inline stylesheets into a single <style> tag skipped, no inline stylesheets to merge',
      )
      return
    }
    const first = styles[0]!
    let sheet = first.textContent

    for (let i = 1; i < styles.length; i++) {
      const node = styles[i]!
      sheet += node.textContent
      node.remove()
    }

    first.textContent = sheet
  }

  /**
   * Given href, find the corresponding CSS asset
   */
  async getCssAsset(href: string, _style?: unknown): Promise<string | undefined> {
    const outputPath = this.options.path
    const publicPath = this.options.publicPath

    // CHECK - the output path
    // path on disk (with output.publicPath removed)
    let normalizedPath = href.replace(/^\//, '')
    const pathPrefix = `${(publicPath || '').replace(/(^\/|\/$)/g, '')}/`
    if (normalizedPath.startsWith(pathPrefix)) {
      normalizedPath = normalizedPath
        .substring(pathPrefix.length)
        .replace(/^\//, '')
    }

    // Ignore remote stylesheets
    if (/^https?:\/\//.test(normalizedPath) || href.startsWith('//')) {
      return undefined
    }

    const filename = path.resolve(outputPath, normalizedPath)
    // Check if the resolved path is valid
    if (!isSubpath(outputPath, filename)) {
      return undefined
    }

    let sheet: string | undefined

    try {
      sheet = await this.readFile(filename)
    }
    catch {
      this.logger.warn?.(`Unable to locate stylesheet: ${filename}`)
    }

    return sheet
  }

  checkInlineThreshold(link: Node, style: Node, sheet: string) {
    if (
      this.options.inlineThreshold
      && sheet.length < this.options.inlineThreshold
    ) {
      const href = style.$$name
      style.$$reduce = false
      this.logger.info?.(
        `\u001B[32mInlined all of ${href} (${sheet.length} was below the threshold of ${this.options.inlineThreshold})\u001B[39m`,
      )
      link.remove()
      return true
    }

    return false
  }

  /**
   * Inline the stylesheets from options.additionalStylesheets (assuming it passes `options.filter`)
   */
  async embedAdditionalStylesheet(document: HTMLDocument) {
    const styleSheetsIncluded: string[] = []

    const sources = await Promise.all(
      this.options.additionalStylesheets.map((cssFile) => {
        if (styleSheetsIncluded.includes(cssFile)) {
          return []
        }
        styleSheetsIncluded.push(cssFile)
        const style = document.createElement('style')
        style.$$external = true
        return this.getCssAsset(cssFile, style).then(sheet => [sheet, style] as const)
      }),
    )

    for (const [sheet, style] of sources) {
      if (sheet) {
        style.textContent = sheet
        document.head.appendChild(style)
      }
    }
  }

  /**
   * Inline the target stylesheet referred to by a <link rel="stylesheet"> (assuming it passes `options.filter`)
   */
  async embedLinkedStylesheet(link: ChildNode, document: HTMLDocument) {
    const href = link.getAttribute('href')
    let media: string | undefined = link.getAttribute('media')

    if (media && !validateMediaQuery(media)) {
      media = undefined
    }

    const preloadMode = this.options.preload

    // skip filtered resources, or network resources if no filter is provided
    if (this.urlFilter ? this.urlFilter(href) : !href?.endsWith('.css')) {
      return undefined
    }

    // the reduced critical CSS gets injected into a new <style> tag
    const style = document.createElement('style')
    style.$$external = true
    const sheet = await this.getCssAsset(href, style)

    if (!sheet) {
      return
    }

    style.textContent = sheet
    style.$$name = href
    style.$$links = [link]
    link.parentNode?.insertBefore(style, link)

    if (this.checkInlineThreshold(link, style, sheet)) {
      return
    }

    // CSS loader is only injected for the first sheet, then this becomes an empty string
    let cssLoaderPreamble
      = 'function $loadcss(u,m,l){(l=document.createElement(\'link\')).rel=\'stylesheet\';l.href=u;document.head.appendChild(l)}'
    const lazy = preloadMode === 'js-lazy'
    if (lazy) {
      cssLoaderPreamble = cssLoaderPreamble.replace(
        'l.href',
        'l.media=\'print\';l.onload=function(){l.media=m};l.href',
      )
    }

    // Allow disabling any mutation of the stylesheet link:
    if (preloadMode === false)
      return

    let noscriptFallback = false
    let updateLinkToPreload = false
    const noscriptLink = link.cloneNode(false)

    if (preloadMode === 'body') {
      document.body.appendChild(link)
    }
    else {
      if (preloadMode === 'js' || preloadMode === 'js-lazy') {
        const script = document.createElement('script')
        script.setAttribute('data-href', href)
        script.setAttribute('data-media', media || 'all')
        const js = `${cssLoaderPreamble}$loadcss(document.currentScript.dataset.href,document.currentScript.dataset.media)`
        // script.appendChild(document.createTextNode(js));
        script.textContent = js
        link.parentNode!.insertBefore(script, link.nextSibling)
        style.$$links.push(script)
        cssLoaderPreamble = ''
        noscriptFallback = true
        updateLinkToPreload = true
      }
      else if (preloadMode === 'media') {
        // @see https://github.com/filamentgroup/loadCSS/blob/af1106cfe0bf70147e22185afa7ead96c01dec48/src/loadCSS.js#L26
        link.setAttribute('media', 'print')
        link.setAttribute('onload', `this.media='${media || 'all'}'`)
        noscriptFallback = true
      }
      else if (preloadMode === 'swap-high') {
        // @see http://filamentgroup.github.io/loadCSS/test/new-high.html
        link.setAttribute('rel', 'alternate stylesheet preload')
        link.setAttribute('title', 'styles')
        link.setAttribute('onload', `this.title='';this.rel='stylesheet'`)
        noscriptFallback = true
      }
      else if (preloadMode === 'swap') {
        link.setAttribute('onload', 'this.rel=\'stylesheet\'')
        noscriptFallback = true
      }
      else {
        const bodyLink = link.cloneNode(false)

        // If an ID is present, remove it to avoid collisions.
        bodyLink.removeAttribute('id')

        document.body.appendChild(bodyLink)
        updateLinkToPreload = true
      }
    }

    if (
      this.options.noscriptFallback !== false
      && noscriptFallback
      // Don't parse the URL if it contains </noscript> as it might cause unexpected behavior
      && !href.includes('</noscript>')
    ) {
      const noscript = document.createElement('noscript')
      // If an ID is present, remove it to avoid collisions.
      noscriptLink.removeAttribute('id')
      noscript.appendChild(noscriptLink)
      link.parentNode!.insertBefore(noscript, link.nextSibling)
      style.$$links.push(noscript)
    }

    if (updateLinkToPreload) {
      // Switch the current link tag to preload
      link.setAttribute('rel', 'preload')
      link.setAttribute('as', 'style')
    }
  }

  /**
   * Prune the source CSS files
   */
  pruneSource(style: Node, before: string, sheetInverse: string) {
    // if external stylesheet would be below minimum size, just inline everything
    const minSize = this.options.minimumExternalSize
    const name = style.$$name
    if (minSize && sheetInverse.length < minSize) {
      this.logger.info?.(
        `\u001B[32mInlined all of ${name} (non-critical external stylesheet would have been ${sheetInverse.length}b, which was below the threshold of ${minSize})\u001B[39m`,
      )
      style.textContent = before
      // remove any associated external resources/loaders:
      if (style.$$links) {
        for (const link of style.$$links) {
          const parent = link.parentNode
          if (parent)
            parent.removeChild(link)
        }
      }

      return true
    }

    return false
  }

  /**
   * Parse the stylesheet within a <style> element, then reduce it to contain only rules used by the document.
   */
  async processStyle(style: Node, document: HTMLDocument) {
    if (style.$$reduce === false)
      return

    const name = style.$$name ? style.$$name.replace(/^\//, '') : 'inline CSS'
    const options = this.options
    const beastiesContainer = document.beastiesContainer!
    let keyframesMode = options.keyframes ?? 'critical'
    // we also accept a boolean value for options.keyframes
    if (keyframesMode === true)
      keyframesMode = 'all'
    if (keyframesMode === false)
      keyframesMode = 'none'

    let sheet = style.textContent

    // store a reference to the previous serialized stylesheet for reporting stats
    const before = sheet

    // Skip empty stylesheets
    if (!sheet)
      return

    const ast = parseStylesheet(sheet)
    const astInverse = options.pruneSource ? parseStylesheet(sheet) : null

    // a string to search for font names (very loose)
    let criticalFonts = ''

    const failedSelectors: string[] = []

    const criticalKeyframeNames = new Set()

    let includeNext = false
    let includeAll = false
    let excludeNext = false
    let excludeAll = false

    const shouldPreloadFonts = options.fonts === true || options.preloadFonts === true
    const shouldInlineFonts = options.fonts !== false && options.inlineFonts === true

    // Walk all CSS rules, marking unused rules with `.$$remove=true` for removal in the second pass.
    // This first pass is also used to collect font and keyframe usage used in the second pass.
    walkStyleRules(
      ast,
      markOnly((rule) => {
        if (rule.type === 'comment') {
          // we might want to remove a leading ! on comment blocks
          // beasties can be part of "legal comments" which aren't striped on build
          // TODO: address regexp
          // eslint-disable-next-line regexp/no-useless-assertions
          const beastiesComment = rule.text.match(/^(?<!! )beasties:(.*)/)
          const command = beastiesComment && beastiesComment[1]

          if (command) {
            switch (command) {
              case 'include':
                includeNext = true
                break
              case 'exclude':
                excludeNext = true
                break
              case 'include start':
                includeAll = true
                break
              case 'include end':
                includeAll = false
                break
              case 'exclude start':
                excludeAll = true
                break
              case 'exclude end':
                excludeAll = false
                break
            }
          }
        }

        if (rule.type === 'rule') {
          // Handle comment based markers
          if (includeNext) {
            includeNext = false
            return true
          }

          if (excludeNext) {
            excludeNext = false
            return false
          }

          if (includeAll) {
            return true
          }

          if (excludeAll) {
            return false
          }

          // Filter the selector list down to only those match
          rule.filterSelectors?.((sel) => {
            // Validate rule with 'allowRules' option
            const isAllowedRule = options.allowRules.some((exp) => {
              if (exp instanceof RegExp) {
                return exp.test(sel)
              }
              return exp === sel
            })
            if (isAllowedRule)
              return true

            // Strip pseudo-elements and pseudo-classes, since we only care that their associated elements exist.
            // This means any selector for a pseudo-element or having a pseudo-class will be inlined if the rest of the selector matches.
            if (
              sel === ':root'
              || sel === 'html'
              || sel === 'body'
              || /^::?(?:before|after)$/.test(sel)
            ) {
              return true
            }
            sel = sel
              .replace(/(?<!\\)::?[a-z-]+(?![a-z-(])/gi, '')
              .replace(/::?not\(\s*\)/g, '')
              // Remove tailing or leading commas from cleaned sub selector `is(.active, :hover)` -> `is(.active)`.
              .replace(/\(\s*,/g, '(')
              .replace(/,\s*\)/g, ')')
              .trim()
            if (!sel)
              return false

            try {
              return beastiesContainer.exists(sel)
            }
            catch (e) {
              failedSelectors.push(`${sel} -> ${(e as Error).message || (e as Error).toString()}`)
              return false
            }
          })

          // If there are no matched selectors, remove the rule:
          if (!rule.selector) {
            return false
          }

          if (rule.nodes) {
            for (const decl of rule.nodes) {
              if (!('prop' in decl)) {
                continue
              }
              // detect used fonts
              if (shouldInlineFonts && /\bfont(?:-family)?\b/i.test(decl.prop)) {
                criticalFonts += ` ${decl.value}`
              }

              // detect used keyframes
              if (decl.prop === 'animation' || decl.prop === 'animation-name') {
                for (const name of decl.value.split(/\s+/)) {
                  // @todo: parse animation declarations and extract only the name. for now we'll do a lazy match.
                  const nameTrimmed = name.trim()
                  if (nameTrimmed)
                    criticalKeyframeNames.add(nameTrimmed)
                }
              }
            }
          }
        }

        // keep font rules, they're handled in the second pass:
        if (rule.type === 'atrule' && rule.name === 'font-face')
          return

        // If there are no remaining rules, remove the whole rule:
        const rules = 'nodes' in rule ? rule.nodes?.filter(rule => !rule.$$remove) : undefined
        return !rules || rules.length !== 0
      }),
    )

    if (failedSelectors.length !== 0) {
      this.logger.warn?.(
        `${
          failedSelectors.length
        } rules skipped due to selector errors:\n  ${failedSelectors.join(
          '\n  ',
        )}`,
      )
    }

    const preloadedFonts = new Set<string>()
    // Second pass, using data picked up from the first
    walkStyleRulesWithReverseMirror(ast, astInverse, (rule) => {
      // remove any rules marked in the first pass
      if (rule.$$remove === true)
        return false

      if ('selectors' in rule) {
        applyMarkedSelectors(rule)
      }

      // prune @keyframes rules
      if (rule.type === 'atrule' && rule.name === 'keyframes') {
        if (keyframesMode === 'none')
          return false
        if (keyframesMode === 'all')
          return true
        return criticalKeyframeNames.has(rule.params)
      }

      // prune @font-face rules
      if (rule.type === 'atrule' && rule.name === 'font-face') {
        let family, src
        if (rule.nodes) {
          for (const decl of rule.nodes) {
            if (!('prop' in decl)) {
              continue
            }
            if (decl.prop === 'src') {
              // TODO: parse this properly and generate multiple preloads with type="font/woff2" etc
              // eslint-disable-next-line regexp/no-super-linear-backtracking,regexp/no-misleading-capturing-group
              src = (decl.value.match(/url\s*\(\s*(['"]?)(.+?)\1\s*\)/) || [])[2]
            }
            else if (decl.prop === 'font-family') {
              family = decl.value
            }
          }

          if (src && shouldPreloadFonts && !preloadedFonts.has(src)) {
            preloadedFonts.add(src)
            const preload = document.createElement('link')
            preload.setAttribute('rel', 'preload')
            preload.setAttribute('as', 'font')
            preload.setAttribute('crossorigin', 'anonymous')
            preload.setAttribute('href', src.trim())
            document.head.appendChild(preload)
          }
        }

        // if we're missing info, if the font is unused, or if critical font inlining is disabled, remove the rule:
        if (
          !shouldInlineFonts
          || !family
          || !src
          || !criticalFonts.includes(family)
        ) {
          return false
        }
      }
    })

    sheet = serializeStylesheet(ast, {
      compress: this.options.compress !== false,
    })

    // If all rules were removed, get rid of the style element entirely
    if (sheet.trim().length === 0) {
      if (style.parentNode) {
        style.remove()
      }
      return
    }

    let afterText = ''
    let styleInlinedCompletely = false
    if (options.pruneSource) {
      const sheetInverse = serializeStylesheet(astInverse!, {
        compress: this.options.compress !== false,
      })

      styleInlinedCompletely = this.pruneSource(style, before, sheetInverse)

      if (styleInlinedCompletely) {
        const percent = (sheetInverse.length / before.length) * 100
        afterText = `, reducing non-inlined size ${
          percent | 0
        }% to ${formatSize(sheetInverse.length)}`
      }
    }

    // replace the inline stylesheet with its critical'd counterpart
    if (!styleInlinedCompletely) {
      style.textContent = sheet
    }

    // output stats
    const percent = ((sheet.length / before.length) * 100) | 0
    this.logger.info?.(
      `\u001B[32mInlined ${
        formatSize(sheet.length)
      } (${
        percent
      }% of original ${
        formatSize(before.length)
      }) of ${
        name
      }${afterText
      }.\u001B[39m`,
    )
  }
}

function formatSize(size: number) {
  if (size <= 0) {
    return '0 bytes'
  }

  const abbreviations = ['bytes', 'kB', 'MB', 'GB']
  const index = Math.floor(Math.log(size) / Math.log(1024))
  const roundedSize = size / 1024 ** index
  // bytes don't have a fraction
  const fractionDigits = index === 0 ? 0 : 2

  return `${roundedSize.toFixed(fractionDigits)} ${abbreviations[index]}`
}