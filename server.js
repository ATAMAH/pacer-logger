const axios            = require('axios');
const { google }       = require('googleapis');
const fs               = require('fs').promises;
const path             = require('path');
const { authenticate } = require('@google-cloud/local-auth');

const pacerClubCode = 'YOUR_PACER_CLUB_CODE'; // without letters, eg '12345678' not 'u12345678'
const spreadsheetId = 'YOUR_GOOGLE_SHEET_ID';
const spreadsheetTab = 'TAB_NAME_IN_YOUR_SPREADSHEET'; // eg 'Sheet1'

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const TOKEN_PATH = path.resolve(__dirname, 'token.json');
const CREDENTIALS_PATH = path.resolve(__dirname, 'key.json');

var sheets;

// SAve google api token to file for auto logging
async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

// Get sheet column name from index
function columnToLetter(column) {
  var temp, letter = '';

  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }

  return letter;
}

async function getSheetData(spreadsheetId, range) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: range,
    });

    console.log(response.data.values);
    return response.data.values;
  } 
  catch (error) {
    console.error('Error fetching data:', error);
    throw error;
  }
}

async function writeDataToSheet(spreadsheetId, range, values) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      resource: { values }
    });

    console.log('Data written to sheet successfully!');
  } 
  catch (error) {
    console.error('Error writing to sheet:', error);
    throw error;
  }
}

async function updateData() {
  let offset = 0;
  let userData = [];

  let chunk;
  
  // fetch data from pacer
  do {
    chunk = await(getData(offset));

    if (chunk) {
      let rankList = chunk.rank_list;

      for (let user of rankList) {
        userData.push(user);
      }

      offset = chunk.paging.anchor;
    }
    else {
      chunk = {
        paging: {
          has_more: true
        }
      };
    }
  } while (chunk.paging.has_more);

  // getting logged to google sheet api
  const auth = await authorize();

  sheets = google.sheets({version: 'v4', auth });

  // fetch whole sheet data
  let sheetData = await getSheetData(spreadsheetId, spreadsheetTab);

  // if no data rows under header row (1)
  // replace whole sheet data with fetched from pacer
  if (sheetData.length < 2) {
    console.log('# Sheet is clear, filling...');

    let dataToWrite = [];

    dataToWrite.push('name', 'userId', 'latestUpdate');

    for (let user of userData) {
      // row data by columns
      let insert = [];

      // user name
      insert.push(user.display_text.main);

      // user id
      insert.push(user.link.id);
      insert.push(user.latest_updated_unixtime);

      dataToWrite.push(insert);
    }

    await writeDataToSheet(spreadsheetId, `${spreadsheetTab}!A1`, dataToWrite);
  }

  // update data once again
  sheetData = await getSheetData(spreadsheetId, spreadsheetId);

  if (sheetData.length > 1) {
    // getting current columns count
    let cols = sheetData[1].length;

    // getting first free column name
    let lastColumnName = columnToLetter(cols + 1);

    let userIdToIndex = {};

    // sort all new data by user id in case of pacer
    // data will be sorted other way than previous update
    for (let i = 0; i < sheetData.length; i++) {
      // getting user id from sheet
      let id = sheetData[i][1];
  
      // and save row index for this user
      userIdToIndex[id] = i;
    }

    let dataToWrite = Array(sheetData.length + 1); // data rows + header row
    let updateToWrite = Array(sheetData.length); // and update 'latestUpdate' column from pacer data

    dataToWrite[0] = [ (Date.now() / 1000).toFixed(0) ]; // header cell filled with current datetime

    for (let user of userData) {
      dataToWrite[userIdToIndex[user.link.id]] = [ parseInt(user.display_score_text) ];
      updateToWrite[userIdToIndex[user.link.id]] = [ user.latest_updated_unixtime ];
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${spreadsheetTab}!C2:C${2 + updateToWrite.length}`, // index from 1 then 1 row header
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: updateToWrite,
      },
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${spreadsheetTab}!${lastColumnName}1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: dataToWrite,
      },
    });
  }
}

async function getData(offset) {
  try {
    let res = await axios.get(`https://www.mypacer.com/api/v1/leaderboard/${pacerClubCode}`, {
      params: {
        anchor: offset
      }
    });

    if (res.status == 200) {
      return res.data.data;
    }
  }
  catch(e) {
    return null;
  }
}

updateData();