/*global Components: false */
/*jshint -W097 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


"use strict";

var EXPORTED_SYMBOLS = ["EnigmailConfigBackup"];

Components.utils.import("resource://enigmail/log.jsm"); /* global EnigmailLog: false */
Components.utils.import("resource://enigmail/rules.jsm"); /* global EnigmailRules: false */
Components.utils.import("resource://enigmail/files.jsm"); /* global EnigmailFiles: false */
Components.utils.import("resource://enigmail/prefs.jsm"); /* global EnigmailPrefs: false */

const Cc = Components.classes;
const Ci = Components.interfaces;

const TYPE_BOOL = 1;
const TYPE_CHAR = 2;
const TYPE_INT = 3;

const IdentityPref = {
  enablePgp: TYPE_BOOL,
  pgpkeyId: TYPE_CHAR,
  pgpKeyMode: TYPE_INT,
  pgpSignPlain: TYPE_BOOL,
  pgpSignEncrypted: TYPE_BOOL,
  defaultSigningPolicy: TYPE_INT,
  defaultEncryptionPolicy: TYPE_INT,
  openPgpHeaderMode: TYPE_INT,
  openPgpUrlName: TYPE_CHAR,
  pgpMimeMode: TYPE_BOOL,
  attachPgpKey: TYPE_BOOL,
  autoEncryptDrafts: TYPE_BOOL
};

var EnigmailConfigBackup = {

  getAccountManager: function() {
    let amService = Cc["@mozilla.org/messenger/account-manager;1"].getService(Ci.nsIMsgAccountManager);
    return amService;
  },

  /**
   * itereate over all identities and execute a callback function for each found element
   *
   * @param callbackFunc  function  - the callback for each identity
   *                  The function takes the identity as 1st argument, i.e.
   *                    callbackFunc(nsIMsgIdentity)
   * @return  - undefined
   */
  forAllIdentitites: function(callbackFunc) {

    let amService = this.getAccountManager();

    amService.LoadAccounts(); // ensure accounts are really loaded
    let a = amService.allIdentities;
    for (let i = 0; i < a.length; i++) {
      let id = a.queryElementAt(i, Ci.nsIMsgIdentity);
      try {
        callbackFunc(id);
      }
      catch (ex) {
        EnigmailLog.DEBUG("configBackup.jsm: forAllIdentitites: exception " + ex.toString() + "\n");
      }
    }
  },

  /**
   * backup Enigmail preferences to a file
   *
   * @param outputFile  nsIFile - handle to file to be saved
   *
   * @return 0: success, other values: failure
   */
  backupPrefs: function(outputFile) {
    EnigmailLog.DEBUG("configBackup.jsm: backupPrefs\n");

    // user preference
    let prefObj = {
      enigmailPrefs: EnigmailPrefs.getAllPrefs(),
      mailIdentities: {}
    };

    function getIdentityPrefs(identity) {

      if (!identity.getBoolAttribute("enablePgp")) return; // do nothing if Enigmail disabled

      let keyObj = {
        emailAddress: identity.email.toLowerCase(),
        identityName: identity.identityName
      };

      for (let pref in IdentityPref) {
        switch (IdentityPref[pref]) {
          case TYPE_BOOL:
            keyObj[pref] = identity.getBoolAttribute(pref);
            break;
          case TYPE_INT:
            keyObj[pref] = identity.getIntAttribute(pref);
            break;
          case TYPE_CHAR:
            keyObj[pref] = identity.getCharAttribute(pref);
            break;
        }
      }

      prefObj.mailIdentities[identity.key] = keyObj;
    }

    this.forAllIdentitites(getIdentityPrefs);

    // per-recipient rules (aka pgpRules.xml)
    var rulesFile = EnigmailRules.getRulesFile();
    if (rulesFile.exists()) {
      prefObj.rules = EnigmailFiles.readFile(rulesFile);
    }

    // serialize everything to UTF-8 encoded JSON.
    var strm = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
    var nativeJSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);

    try {
      strm.init(outputFile, -1, -1, 0);
      nativeJSON.encodeToStream(strm, "UTF-8", false, prefObj);
      strm.close();
    }
    catch (ex) {
      return -1;
    }

    return 0;
  },

  /**
   * Restore Enigmail preferences from a file as generated by backpPrefs()
   *
   * @param inputFile  nsIFile - handle to file to be saved
   *
   * @return Object: {
   *     retVal:       Number - 0: success, other values: failure
   *     unmatchedIds: Array (String): keys of identities
   *   }
   */
  restorePrefs: function(inputFile) {
    EnigmailLog.DEBUG("configBackup.jsm: restorePrefs\n");
    var prefObj;
    var returnObj = {
      retVal: -1,
      unmatchedIds: []
    };

    function setIdentityPref(identity) {
      for (let k in prefObj.mailIdentities) {
        if (prefObj.mailIdentities[k].emailAddress === identity.email.toLowerCase()) {
          EnigmailLog.DEBUG("configBackup.jsm: setIdentityPref: restoring values for " + identity.email + "\n");
          prefObj.mailIdentities[k].foundMatchingEmail = true;
          let keyObj = prefObj.mailIdentities[k];
          for (let pref in IdentityPref) {
            switch (IdentityPref[pref]) {
              case TYPE_BOOL:
                identity.setBoolAttribute(pref, keyObj[pref]);
                break;
              case TYPE_INT:
                identity.setIntAttribute(pref, keyObj[pref]);
                break;
              case TYPE_CHAR:
                identity.setCharAttribute(pref, keyObj[pref]);
                break;
            }
          }
          return;
        }
      }

      EnigmailLog.DEBUG("configBackup.jsm: setIdentityPref: no matching data for " + identity.email + "\n");
    }

    // Profile must be a single UTF-8 encoded JSON object.
    var strm = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    var nativeJSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);

    try {
      strm.init(inputFile, -1, -1, 0);
      prefObj = nativeJSON.decodeFromStream(strm, "UTF-8", false);
      strm.close();

      var nsIPB = Ci.nsIPrefBranch;
      var branch = EnigmailPrefs.getPrefBranch();

      // Set all options recorded in the JSON file.
      for (let name in prefObj.enigmailPrefs) {
        EnigmailPrefs.setPref(name, prefObj.enigmailPrefs[name]);
      }

      this.forAllIdentitites(setIdentityPref);

      for (let i in prefObj.mailIdentities) {
        if (!("foundMatchingEmail" in prefObj.mailIdentities[i])) {
          returnObj.unmatchedIds.push(prefObj.mailIdentities[i].identityName);
        }
      }

      let am = this.getAccountManager();
      am.saveAccountInfo();
      EnigmailPrefs.savePrefs();

      if ("rules" in prefObj) {
        EnigmailRules.loadRulesFromString(prefObj.rules);
        EnigmailRules.saveRulesFile();
      }

    }
    catch (ex) {
      EnigmailLog.ERROR("configBackup.jsm: restorePrefs - exception " + ex.toString() + "\n");
      return returnObj;
    }

    returnObj.retVal = 0;
    return returnObj;
  }

};