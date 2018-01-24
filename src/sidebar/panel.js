/* exported TEXT_ALIGN_DIR */
const UI_LANG = browser.i18n.getUILanguage();
const RTL_LANGS = ['ar', 'fa', 'he'];
const LANG_DIR = RTL_LANGS.includes(UI_LANG) ? 'rtl' : 'ltr';
const TEXT_ALIGN_DIR = LANG_DIR === 'rtl' ? 'right' : 'left';
const SURVEY_PATH = 'https://qsurvey.mozilla.com/s3/notes?ref=sidebar';

const footerButtons = document.getElementById('footer-buttons');
const enableSync = document.getElementById('enable-sync');
const giveFeedbackButton = document.getElementById('give-feedback-button');
const giveFeedbackMenuItem = document.getElementById('give-feedback');
const savingIndicator = document.getElementById('saving-indicator');
savingIndicator.textContent = browser.i18n.getMessage('changesSaved');

const disconnectSync = document.getElementById('disconnect-from-sync');
disconnectSync.style.display = 'none';
disconnectSync.textContent = browser.i18n.getMessage('disableSync');

const INITIAL_CONTENT = `<h2>${browser.i18n.getMessage('welcomeTitle3')}</h2><p>${browser.i18n.getMessage('welcomeSubtitle3')}</p><p><strong>${browser.i18n.getMessage('welcomeOpenNotes3')}</strong></p><ul><li>${browser.i18n.getMessage('welcomeWindowsLinuxShortcut3', '<code>Alt+Shift+W</code>')}</li><li>${browser.i18n.getMessage('welcomeMacShortcut3', '<code>Opt+Shift+W</code>')}</li></ul><p><strong>${browser.i18n.getMessage('welcomeAccessNotes3')}</strong></p><ul><li>${browser.i18n.getMessage('welcomeSyncInfo3', '<strong>' + browser.i18n.getMessage('syncNotes') + '</strong>')}</li></ul><p><strong>${browser.i18n.getMessage('welcomeFormatText3')}</strong> ${browser.i18n.getMessage('welcomeFormatUse3')}</p><ul><li>${browser.i18n.getMessage('welcomeHeading3').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeBold3').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeItalics3').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeBulleted3').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeNumbered3').replace(/ `/g, ' <code>').replace(/`/g, '</code>')}</li><li>${browser.i18n.getMessage('welcomeCode3').replace(/ ``/g, ' <code>`').replace(/``/g, '`</code>')}</li></ul><p><strong>${browser.i18n.getMessage('welcomeSuggestion3')}</strong></p><ul><li>${browser.i18n.getMessage('welcomeGiveFeedback3', '<strong>' + browser.i18n.getMessage('feedback') + '</strong>' )}</li></ul><p><strong>${browser.i18n.getMessage('welcomeThatsIt3')}</strong>${browser.i18n.getMessage('welcomeReady3')}</p>`;

let isAuthenticated = false;
let waitingToReconnect = false;
let loginTimeout;
let editingInProcess = false;
let syncingInProcess = false;

enableSync.setAttribute('title', browser.i18n.getMessage('syncNotes'));
giveFeedbackButton.setAttribute('title', browser.i18n.getMessage('feedback'));
giveFeedbackMenuItem.text = browser.i18n.getMessage('feedback');
giveFeedbackButton.setAttribute('href', SURVEY_PATH);
giveFeedbackMenuItem.setAttribute('href', SURVEY_PATH);

// ignoreNextLoadEvent is used to make sure the update does not trigger on other sidebars
let ignoreNextLoadEvent = false;
let ignoreTextSynced = false;
let lastModified;

ClassicEditor.create(document.querySelector('#editor'), {
  heading: {
    options: [
      { modelElement: 'paragraph', title: 'P', class: 'ck-heading_paragraph' },
      { modelElement: 'heading3', viewElement: 'h3', title: 'H3', class: 'ck-heading_heading3' },
      { modelElement: 'heading2', viewElement: 'h2', title: 'H2', class: 'ck-heading_heading2' },
      { modelElement: 'heading1', viewElement: 'h1', title: 'H1', class: 'ck-heading_heading1' }
    ]
  },
  toolbar: ['headings', 'bold', 'italic', 'strike', 'bulletedList', 'numberedList'],
}).then(editor => {
  return migrationCheck(editor)
    .then(() => {
      editor.document.on('change', (eventInfo, name) => {
        const isFocused = document.querySelector('.ck-editor__editable').classList.contains('ck-focused');
        // Only use the focused editor or handle 'rename' events to set the data into storage.
        if (isFocused || name === 'rename' || name === 'insert') {
          const content = editor.getData();
          if (!ignoreNextLoadEvent && content !== undefined &&
              content.replace('&nbsp;', ' ') !== INITIAL_CONTENT) {
            ignoreTextSynced = true;
            chrome.runtime.sendMessage({
              action: 'kinto-save',
              content
            });

            chrome.runtime.sendMessage({
              action: 'metrics-changed',
              context: getPadStats(editor)
            });
          }
        }
        ignoreNextLoadEvent = false;
      });
      
      savingIndicator.onclick = () => {
        enableSyncAction(editor);
      };
      // to make reconnectSync text Field act like savingIndicator
      enableSync.onclick = () => {
        enableSyncAction(editor);
      };

      customizeEditor(editor);
      loadContent();

      chrome.runtime.onMessage.addListener(eventData => {
        let content;
        switch (eventData.action) {
          case 'sync-authenticated':
            setAnimation(true, true, false); // animateSyncIcon, syncingLayout, warning
            isAuthenticated = true;
            waitingToReconnect = false;
            clearTimeout(loginTimeout);
            // set title attr of footer to the currently logged in account
            footerButtons.title = eventData.profile && eventData.profile.email;
            savingIndicator.textContent = browser.i18n.getMessage('syncProgress');
            browser.runtime.sendMessage({
              action: 'kinto-sync'
            });
            break;
          case 'kinto-loaded':
            clearTimeout(loginTimeout);
            content = eventData.data;
            // Switch to Date.now() to show when we pulled notes instead of 'eventData.last_modified'
            lastModified = Date.now();
            getLastSyncedTime();
            handleLocalContent(editor, content);
            document.getElementById('loading').style.display = 'none';
            break;
          case 'text-change':
            ignoreNextLoadEvent = true;
            browser.runtime.sendMessage({
              action: 'kinto-load'
            });
            break;
          case 'text-syncing':
            setAnimation(true); // animateSyncIcon, syncingLayout, warning
            savingIndicator.textContent = browser.i18n.getMessage('syncProgress');
            // Disable sync-action
            syncingInProcess = true;
            break;
          case 'text-editing':
            if (isAuthenticated) {
              setAnimation(true); // animateSyncIcon, syncingLayout, warning
              syncingInProcess = true;
            }
            if (!waitingToReconnect) {
              if (isAuthenticated) {
                savingIndicator.textContent = browser.i18n.getMessage('syncProgress');
              } else {
                savingIndicator.textContent = browser.i18n.getMessage('savingChanges');
              }
            }
            // Disable sync-action
            editingInProcess = true;
            break;
          case 'text-synced':
            lastModified = eventData.last_modified;
            if (!ignoreTextSynced || eventData.conflict) {
              handleLocalContent(editor, eventData.content);
            }
            ignoreTextSynced = false;
            getLastSyncedTime();
            // Enable sync-action
            syncingInProcess = false;
            break;
          case 'text-saved':
            if (! waitingToReconnect && ! isAuthenticated) {
              // persist reconnect warning, do not override with the 'saved at'
              savingIndicator.textContent = browser.i18n.getMessage('savedComplete2', formatFooterTime());
            }
            // Enable sync-action
            editingInProcess = false;
            break;
          case 'reconnect':
            clearTimeout(loginTimeout);
            reconnectSync();
            // Enable sync-action
            syncingInProcess = false;
            break;
          case 'disconnected':
            disconnectSync.style.display = 'none';
            footerButtons.title = null; // remove profile email from title attribute
            isAuthenticated = false;
            setAnimation(false, false, false); // animateSyncIcon, syncingLayout, warning
            getLastSyncedTime();
            break;
        }
      });
    });

}).catch(error => {
  console.error(error); // eslint-disable-line no-console
});

function loadContent() {
  browser.storage.local.get('credentials').then((data) => {
    if (data.hasOwnProperty('credentials')) {
      isAuthenticated = true;
    }
  });
  chrome.runtime.sendMessage({
    action: 'kinto-sync'
  });

}

function handleLocalContent(editor, content) {
  if (!content) {
    browser.storage.local.get('notes2').then((data) => {
      if (!data.hasOwnProperty('notes2')) {
        editor.setData(INITIAL_CONTENT);
        ignoreNextLoadEvent = true;
      } else {
        editor.setData(data.notes2);
        chrome.runtime.sendMessage({
          action: 'kinto-save',
          content: data.notes2
        }).then(() => {
          // Clean-up
          browser.storage.local.remove('notes2');
        });
      }
    });
  } else {
    if (editor.getData() !== content) {
      editor.setData(content);
    }
  }
}

function reconnectSync () {
  waitingToReconnect = true;
  isAuthenticated = false;
  setAnimation(false, true, true); // animateSyncIcon, syncingLayout, warning
  savingIndicator.textContent = browser.i18n.getMessage('reconnectSync');
  chrome.runtime.sendMessage({
    action: 'metrics-reconnect-sync'
  });
}

function disconnectFromSync () {
  waitingToReconnect = false;
  disconnectSync.style.display = 'none';
  giveFeedbackButton.style.display = 'inherit';
  isAuthenticated = false;
  setAnimation(false, false, false); // animateSyncIcon, syncingLayout, warning
  setTimeout(() => {
    savingIndicator.textContent = browser.i18n.getMessage('disconnected');
  }, 200);
  setTimeout(() => {
    getLastSyncedTime();
  }, 2000);
  browser.runtime.sendMessage('notes@mozilla.com', {
    action: 'disconnected'
  });
}

disconnectSync.addEventListener('click', disconnectFromSync);

function enableSyncAction(editor) {
  if (editingInProcess || syncingInProcess) {
    return;
  }

  if (isAuthenticated && footerButtons.classList.contains('syncingLayout')) {
    // Trigger manual sync
    giveFeedbackButton.style.display = 'none';
    setAnimation(true);
    browser.runtime.sendMessage({
        action: 'kinto-sync'
      });
  } else if (!isAuthenticated && (footerButtons.classList.contains('savingLayout') || waitingToReconnect)) {
    // Login
    giveFeedbackButton.style.display = 'none';
    setAnimation(true, true, false);  // animateSyncIcon, syncingLayout, warning

    // enable disable sync button
    disconnectSync.style.display = 'block';

    setTimeout(() => {
      savingIndicator.textContent = browser.i18n.getMessage('openingLogin');
    }, 200); // Delay text for smooth animation

    loginTimeout = setTimeout(() => {
      setAnimation(false, true, true); // animateSyncIcon, syncingLayout, warning
      savingIndicator.textContent = browser.i18n.getMessage('pleaseLogin');
      waitingToReconnect = true;
    }, 5000);

    browser.runtime.sendMessage({
      action: 'authenticate',
      context: getPadStats(editor)
    });
  }

  waitingToReconnect = false;
}

function getLastSyncedTime() {
  if (waitingToReconnect) {
    // persist reconnect warning, do not override with the 'saved at'
    return;
  }

  if (isAuthenticated) {
    giveFeedbackButton.style.display = 'none';
    savingIndicator.textContent = browser.i18n.getMessage('syncComplete2', formatFooterTime(lastModified));
    disconnectSync.style.display = 'block';
    isAuthenticated = true;
    setAnimation(false, true);
  } else {
    savingIndicator.textContent = browser.i18n.getMessage('changesSaved', formatFooterTime());
  }
}

document.addEventListener('DOMContentLoaded', getLastSyncedTime);

// Create a connection with the background script to handle open and
// close events.
browser.runtime.connect();
