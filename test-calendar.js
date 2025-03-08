const fs = require('fs');
const { google } = require('googleapis');
const readline = require('readline');

// Ruta al archivo de credenciales
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// Función principal
async function main() {
    try {
        // Leer credenciales
        const content = fs.readFileSync(CREDENTIALS_PATH);
        const credentials = JSON.parse(content);
        
        // Configurar cliente OAuth2
        let clientId, clientSecret, redirectUri;
        
        if (credentials.installed) {
            clientId = credentials.installed.client_id;
            clientSecret = credentials.installed.client_secret;
            redirectUri = credentials.installed.redirect_uris[0];
        } else if (credentials.web) {
            clientId = credentials.web.client_id;
            clientSecret = credentials.web.client_secret;
            redirectUri = credentials.web.redirect_uris[0];
        } else {
            throw new Error('Formato de credenciales no reconocido');
        }
        
        const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
        
        // Comprobar si ya tenemos token
        if (fs.existsSync(TOKEN_PATH)) {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
            oAuth2Client.setCredentials(token);
            await listEvents(oAuth2Client);
        } else {
            await getNewToken(oAuth2Client);
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

// Obtener nuevo token
async function getNewToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });
    
    console.log('Autoriza esta aplicación visitando esta URL:', authUrl);
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    
    return new Promise((resolve, reject) => {
        rl.question('Ingresa el código de la página de autorización: ', async (code) => {
            rl.close();
            try {
                const { tokens } = await oAuth2Client.getToken(code);
                oAuth2Client.setCredentials(tokens);
                
                // Guardar token para uso futuro
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
                console.log('Token almacenado en', TOKEN_PATH);
                
                await listEvents(oAuth2Client);
                resolve();
            } catch (error) {
                console.error('Error al obtener el token de acceso:', error);
                reject(error);
            }
        });
    });
}

// Listar eventos para verificar que la autenticación funciona
async function listEvents(auth) {
    const calendar = google.calendar({ version: 'v3', auth });
    try {
        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: new Date().toISOString(),
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });
        
        const events = res.data.items;
        if (events.length) {
            console.log('Próximos 10 eventos:');
            events.map((event, i) => {
                const start = event.start.dateTime || event.start.date;
                console.log(`${start} - ${event.summary}`);
            });
        } else {
            console.log('No se encontraron eventos próximos.');
        }
    } catch (error) {
        console.error('Error al listar eventos:', error);
    }
}

main();