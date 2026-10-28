/* Image references stay portable Markdown; image bytes remain in the asset store. */
(function (root) {
  'use strict';
  const ASSET = /^\/assets\/[A-Za-z0-9_.:-]+$/;
  const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const EXTENSIONS = {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp'};
  const captionText = value => String(value ?? '').replace(/\\([\\\[\]])/g, '$1');
  const escapedCaption = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\\\[\]]/g, '\\$&');
  const escapedAt = (text, offset) => {let count = 0; while (offset > 0 && text[--offset] === '\\') count++; return count % 2 === 1;};

  // Never offer image controls for literal examples inside fenced or inline code.
  function references(value) {
    const source = String(value ?? ''), result = [];
    let offset = 0, fence = null, inlineTicks = 0;
    for (const raw of source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || []) {
      if (!raw) continue;
      const line = raw.replace(/[\r\n]+$/, ''), marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      } else if (marker && !inlineTicks) {
        fence = {char: marker[1][0], length: marker[1].length};
      } else if (!/^ {4}|^\t/.test(line) || inlineTicks) {
        const tokens = /`+|!\[((?:\\.|[^\]\\\r\n])*)\]\((\/assets\/[A-Za-z0-9_.:-]+)\)/g;
        for (const match of line.matchAll(tokens)) {
          if (escapedAt(line, match.index)) continue;
          if (match[0][0] === '`') {
            if (!inlineTicks) inlineTicks = match[0].length;
            else if (inlineTicks === match[0].length) inlineTicks = 0;
          } else if (!inlineTicks) {
            result.push({start: offset + match.index, end: offset + match.index + match[0].length,
              raw: match[0], source: match[2], caption: captionText(match[1])});
          }
        }
      }
      offset += raw.length;
    }
    return result;
  }

  function imageMarkdown(source, caption = '') {
    if (!ASSET.test(source)) throw new Error('The image address is invalid.');
    return '![' + escapedCaption(caption) + '](' + source + ')';
  }

  function replaceReference(value, reference, replacement) {
    const source = String(value ?? '');
    const current = references(source).find(item => item.start === reference.start && item.raw === reference.raw);
    if (!current) throw new Error('The explanation changed. Choose the image again.');
    return source.slice(0, current.start) + replacement + source.slice(current.end);
  }

  function insertImages(value, images, selection = {}) {
    const source = String(value ?? '');
    // Adding an image never deletes selected explanation text.
    const cursor = Math.max(0, Math.min(source.length, Number.isFinite(selection.end) ? selection.end : source.length));
    const before = source.slice(0, cursor), after = source.slice(cursor);
    const insertion = (before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '')
      + images.map(item => imageMarkdown(item.source, item.caption)).join('\n\n')
      + (after.startsWith('\n') ? '\n' : '\n\n');
    return {value: before + insertion + after, cursor: cursor + insertion.length};
  }

  function remapSelection(selection, start, end, replacementLength) {
    const move = position => position <= start ? position : position >= end ? position + replacementLength - (end - start) : start + replacementLength;
    const nextEnd = move(selection.end);
    return {start: Number.isFinite(selection.start) ? move(selection.start) : nextEnd, end: nextEnd};
  }

  function mimeType(file) {
    const supplied = String(file?.type || '').toLowerCase();
    return supplied && supplied !== 'application/octet-stream' ? supplied : EXTENSIONS[String(file?.name || '').split('.').at(-1).toLowerCase()] || '';
  }

  function validateFile(file) {
    const type = mimeType(file);
    if (!TYPES.has(type)) throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');
    if (!file || file.size <= 0) throw new Error('This image is empty. Choose another image.');
    if (file.size > 8 * 1024 * 1024) throw new Error('Choose an image no larger than 8 MB.');
    return type;
  }

  function mount({section, field, picker, isBusy, run, upload, changed, imageSource, openImage, beforePicker}) {
    const list = section.querySelector('[data-image-list]'), status = section.querySelector('[data-image-status]');
    let selection = {end: field.value.length}, pickerTarget = null, pending = false, renderedKeys = '', dragDepth = 0;
    function say(message, error = false) {status.textContent = message; status.hidden = !message; status.dataset.error = String(error);}
    function capture() {selection = {start: field.selectionStart, end: field.selectionEnd};}
    function contentChanged() {changed(); render();}
    function editReference(ref, replacement) {
      field.value = replaceReference(field.value, ref, replacement);
      selection = remapSelection(selection, ref.start, ref.end, replacement.length);
      field.setSelectionRange(selection.start, selection.end);
    }
    function render() {
      const refs = references(field.value), occurrences = new Map();
      const keys = refs.map(ref => {const count = (occurrences.get(ref.source) || 0) + 1; occurrences.set(ref.source, count); return ref.source + ':' + count;}).join('|');
      if (keys !== renderedKeys || list.children.length !== refs.length) {
        list.innerHTML = refs.map((ref, index) => '<div class="image-editor-card" data-image-index="' + index + '">'
          + '<button type="button" class="image-editor-thumbnail" data-image-editor="view" aria-label="Enlarge image ' + (index + 1) + '"><img alt="" loading="lazy"><span>Enlarge</span></button>'
          + '<div class="image-editor-card-body"><label class="field">Caption <span class="optional">optional</span><input class="image-editor-caption" data-image-caption maxlength="1000" placeholder="Describe what this image shows"></label>'
          + '<div class="image-editor-card-actions"><button type="button" class="text-button" data-image-editor="replace">Replace image</button><button type="button" class="text-button" data-image-editor="remove">Remove from explanation</button></div></div></div>').join('');
        renderedKeys = keys;
      }
      refs.forEach((ref, index) => {
        const card = list.children[index], image = card.querySelector('img'), input = card.querySelector('[data-image-caption]');
        const src = imageSource(ref.source);
        if (image.getAttribute('src') !== src) image.setAttribute('src', src);
        image.alt = ref.caption || 'Image ' + (index + 1);
        card.querySelector('[data-image-editor="view"]').setAttribute('aria-label', ref.caption ? 'Enlarge image: ' + ref.caption : 'Enlarge image ' + (index + 1));
        if (root.document.activeElement !== input) input.value = ref.caption;
      });
      list.hidden = !refs.length;
      section.querySelector('[data-image-count]').textContent = refs.length ? refs.length + ' in this explanation' : 'Screenshots, diagrams, and photos';
    }
    function reset() {selection = {end: field.value.length}; pickerTarget = null; renderedKeys = ''; say(''); render();}
    function choose(target = null) {
      if (isBusy() || pending) return;
      pickerTarget = target;
      picker.multiple = !target;
      picker.value = '';
      beforePicker();
      // Keep this synchronous in the user's click: browsers may reject delayed pickers.
      picker.click();
    }
    async function addFiles(values, target = null) {
      const files = [...values].filter(Boolean);
      if (!files.length) return;
      if (isBusy() || pending) {say('Please wait for the current change to finish.', true); return;}
      const insertionPoint = {...selection}, errors = [];
      let added = 0;
      pending = true; section.setAttribute('aria-busy', 'true');
      try {
        await run(async () => {
          for (const [index, file] of files.entries()) {
            say('Adding image ' + (index + 1) + ' of ' + files.length + '…');
            try {
              const type = validateFile(file), saved = await upload(file, type);
              if (!ASSET.test(saved.url)) throw new Error('The image address is invalid.');
              if (target) {
                editReference(target, imageMarkdown(saved.url, target.caption));
              } else {
                const insertion = insertImages(field.value, [{source: saved.url, caption: file.name || 'Pasted image'}], added ? selection : insertionPoint);
                field.value = insertion.value; selection = {end: insertion.cursor};
              }
              added++; contentChanged();
            } catch (error) {errors.push((file.name || 'Pasted image') + ': ' + error.message);}
          }
        });
      } catch (error) {errors.push(error.message);}
      finally {pending = false; section.removeAttribute('aria-busy');}
      if (added) {field.setSelectionRange(selection.end, selection.end); field.focus();}
      const summary = added ? added + ' image' + (added === 1 ? '' : 's') + (target ? ' replaced.' : ' added.') + ' Save shard when ready.' : '';
      say([summary, ...errors].filter(Boolean).join(' '), !!errors.length);
      return {added, errors};
    }

    section.addEventListener('click', event => {
      const button = event.target.closest('[data-image-editor]');
      if (!button || isBusy() || pending) return;
      event.preventDefault(); event.stopPropagation();
      const action = button.dataset.imageEditor;
      if (action === 'choose') {choose(); return;}
      const index = Number(button.closest('[data-image-index]')?.dataset.imageIndex), ref = references(field.value)[index];
      if (!ref) return;
      if (action === 'view') openImage(ref.source, ref.caption, button);
      else if (action === 'replace') choose(ref);
      else if (action === 'remove') {
        editReference(ref, ''); contentChanged();
        say('Image removed from this explanation. Save shard when ready.');
        section.querySelector('[data-image-editor="choose"]').focus();
      }
    });
    section.addEventListener('input', event => {
      if (!event.target.matches('[data-image-caption]') || isBusy() || pending) return;
      const index = Number(event.target.closest('[data-image-index]').dataset.imageIndex), ref = references(field.value)[index];
      if (!ref) return;
      editReference(ref, imageMarkdown(ref.source, event.target.value));
      contentChanged();
    });
    for (const name of ['select', 'keyup', 'click', 'input']) field.addEventListener(name, capture);
    picker.addEventListener('change', () => {const files = [...picker.files], target = pickerTarget; pickerTarget = null; picker.value = ''; void addFiles(target ? files.slice(0, 1) : files, target);});
    picker.addEventListener('cancel', () => {pickerTarget = null;});
    field.addEventListener('paste', event => {
      const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && (!item.type || item.type.startsWith('image/'))).map(item => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      event.preventDefault(); capture(); void addFiles(files);
    });
    for (const element of [section, field]) {
      element.addEventListener('dragenter', event => {if (![...(event.dataTransfer?.types || [])].includes('Files')) return; event.preventDefault(); dragDepth++; section.classList.add('image-drop-active');});
      element.addEventListener('dragover', event => {if (![...(event.dataTransfer?.types || [])].includes('Files')) return; event.preventDefault(); event.dataTransfer.dropEffect = isBusy() || pending ? 'none' : 'copy';});
      element.addEventListener('dragleave', () => {if (--dragDepth <= 0) {dragDepth = 0; section.classList.remove('image-drop-active');}});
      element.addEventListener('drop', event => {const files = [...(event.dataTransfer?.files || [])]; if (!files.length) return; event.preventDefault(); event.stopPropagation(); dragDepth = 0; section.classList.remove('image-drop-active'); void addFiles(files);});
    }
    return Object.freeze({render, reset, choose, addFiles, capture});
  }

  root.ShardAtlasImageEditor = Object.freeze({references, imageMarkdown, replaceReference, insertImages, remapSelection, mimeType, validateFile, captionText, mount});
})(window);
