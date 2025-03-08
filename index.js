const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

// Configuración para la autenticación con Google Calendar
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const CREDENTIALS_PATH = 'credentials.json';

// Inicializar cliente de WhatsApp con opciones adicionales
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    },
    webVersionCache: {
        type: 'none'  // Desactivar el caché de versión web que está causando el error
    }
});

// Estado de las conversaciones (para seguir el flujo de reserva)
const conversationStates = {};

// Servicios ofrecidos por la peluquería con sus duraciones (en minutos)
const servicios = {
    "1": { nombre: "Corte de cabello", duracion: 30 },
    "2": { nombre: "Tinte", duracion: 120 },
    "3": { nombre: "Peinado", duracion: 45 },
    "4": { nombre: "Tratamiento capilar", duracion: 60 },
    "5": { nombre: "Manicura", duracion: 45 }
};

// Horarios disponibles de la peluquería
const horariosDisponibles = ["10:00", "11:00", "12:00", "13:00", "15:00", "16:00", "17:00", "18:00"];

// Generar QR para conectar WhatsApp
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escanea el código QR con tu teléfono para iniciar sesión');
});

client.on('ready', () => {
    console.log('Bot de WhatsApp listo y conectado');
});

// Autenticación con Google Calendar
function getAccessToken() {
    // Ruta donde guardaremos el token
    const TOKEN_PATH = path.join(__dirname, 'token.json');
    
    try {
        // Leer las credenciales del archivo
        const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
        
        // Extraer las credenciales, adaptándose a diferentes formatos
        let client_id, client_secret;
        
        if (credentials.installed) {
            client_id = credentials.installed.client_id;
            client_secret = credentials.installed.client_secret;
        } else if (credentials.web) {
            client_id = credentials.web.client_id;
            client_secret = credentials.web.client_secret;
        } else {
            throw new Error("Formato de credenciales incorrecto");
        }
        
        // Crear cliente OAuth2 con modo OOB (fuera de banda)
        const oAuth2Client = new google.auth.OAuth2(
            client_id,
            client_secret,
            'urn:ietf:wg:oauth:2.0:oob'  // URL de redirección para modo OOB
        );
        
        // Si ya tenemos un token guardado, lo usamos
        if (fs.existsSync(TOKEN_PATH)) {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
            oAuth2Client.setCredentials(token);
            return oAuth2Client;
        }
        
        // Si no hay token, generamos un nuevo url de autorización
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES
        });
        console.log('Autoriza esta app visitando esta url:', authUrl);
        console.log('Después de autorizar, verás un código en la página que debes copiar aquí:');
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        
        // Solicitar el código de autorización al usuario
        return new Promise((resolve, reject) => {
            rl.question('Ingresa el código de la página de autorización: ', (code) => {
                rl.close();
                
                // Intercambiar el código por un token
                oAuth2Client.getToken(code, (err, token) => {
                    if (err) {
                        console.error('Error al obtener token de acceso:', err);
                        return reject(err);
                    }
                    
                    oAuth2Client.setCredentials(token);
                    
                    // Guardar el token para usos futuros
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
                    console.log('Token guardado en:', TOKEN_PATH);
                    
                    // Devolver el cliente autorizado
                    resolve(oAuth2Client);
                });
            });
        });
    } catch (err) {
        console.error('Error al procesar credenciales:', err);
        throw err;
    }
}

// Verificar disponibilidad en Google Calendar
async function verificarDisponibilidad(fecha, hora) {
    const auth = await getAccessToken(); 
    const calendar = google.calendar({ version: 'v3', auth });
    
    // Calcular fecha y hora en formato ISO
    const fechaHoraInicio = new Date(`${fecha}T${hora}:00`);
    const fechaHoraFin = new Date(fechaHoraInicio.getTime() + 60 * 60 * 1000); // Añadir 1 hora
    
    const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: fechaHoraInicio.toISOString(),
        timeMax: fechaHoraFin.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
    });
    
    const eventos = response.data.items;
    return eventos.length === 0; // True si no hay eventos en ese horario
}

// Crear cita en Google Calendar
async function crearCita(nombre, telefono, servicio, fecha, hora) {
    const auth = await getAccessToken();
    const calendar = google.calendar({ version: 'v3', auth });
    
    const fechaHoraInicio = new Date(`${fecha}T${hora}:00`);
    const fechaHoraFin = new Date(fechaHoraInicio.getTime() + servicios[servicio].duracion * 60 * 1000);
    
    const event = {
        summary: `Cita: ${servicios[servicio].nombre} - ${nombre}`,
        description: `Cliente: ${nombre}\nTeléfono: ${telefono}\nServicio: ${servicios[servicio].nombre}`,
        start: {
            dateTime: fechaHoraInicio.toISOString(),
            timeZone: 'Colombia/Bogota', // Cambiar según la zona horaria
        },
        end: {
            dateTime: fechaHoraFin.toISOString(),
            timeZone: 'Colombia/Bogota', // Cambiar según la zona horaria
        },
    };
    
    try {
        const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
        });
        return response.data;
    } catch (error) {
        console.error('Error al crear el evento:', error);
        return null;
    }
}

// Manejar mensajes entrantes
client.on('message', async (message) => {
    const senderId = message.from;
    const messageContent = message.body.trim().toLowerCase();
    
    // Inicializar estado de conversación si es nueva
    if (!conversationStates[senderId]) {
        conversationStates[senderId] = {
            step: 'inicio',
            nombre: '',
            telefono: '',
            servicio: '',
            fecha: '',
            hora: ''
        };
        
        await client.sendMessage(senderId, 
            '👋 ¡Bienvenido/a a Peluquería Estilo! Soy tu asistente virtual para agendar citas.\n\n' +
            'Para comenzar, por favor escribe tu nombre completo:'
        );
        return;
    }
    
    const state = conversationStates[senderId];
    
    // Manejar diferentes estados de la conversación
    switch (state.step) {
        case 'inicio':
            state.nombre = messageContent;
            state.step = 'telefono';
            await client.sendMessage(senderId, 
                `¡Gracias ${state.nombre}! Por favor, comparte tu número de teléfono de contacto:`
            );
            break;
            
        case 'telefono':
            state.telefono = messageContent;
            state.step = 'servicio';
            
            // Mostrar menú de servicios
            let menuServicios = '¿Qué servicio deseas agendar? Responde con el número correspondiente:\n\n';
            for (const [id, servicio] of Object.entries(servicios)) {
                menuServicios += `${id}. ${servicio.nombre} (${servicio.duracion} min)\n`;
            }
            
            await client.sendMessage(senderId, menuServicios);
            break;
            
        case 'servicio':
            if (!servicios[messageContent]) {
                await client.sendMessage(senderId, 
                    'Por favor, selecciona una opción válida (1-5):'
                );
                return;
            }
            
            state.servicio = messageContent;
            state.step = 'fecha';
            
            await client.sendMessage(senderId, 
                'Perfecto. ¿Para qué fecha deseas agendar? Por favor, usa el formato DD/MM/YYYY (ejemplo: 10/03/2025):'
            );
            break;
            
        case 'fecha':
            // Validar formato de fecha
            const regexFecha = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
            if (!regexFecha.test(messageContent)) {
                await client.sendMessage(senderId, 
                    'Por favor, ingresa la fecha en formato DD/MM/YYYY (ejemplo: 10/03/2025):'
                );
                return;
            }
            
            // Convertir a formato YYYY-MM-DD para Google Calendar
            const partesFecha = messageContent.split('/');
            const fechaFormateada = `${partesFecha[2]}-${partesFecha[1].padStart(2, '0')}-${partesFecha[0].padStart(2, '0')}`;
            
            state.fecha = fechaFormateada;
            state.step = 'hora';
            
            // Mostrar horarios disponibles
            let menuHorarios = 'Selecciona un horario disponible (responde con la hora exacta):\n\n';
            for (const horario of horariosDisponibles) {
                menuHorarios += `- ${horario}\n`;
            }
            
            await client.sendMessage(senderId, menuHorarios);
            break;
            
        case 'hora':
            if (!horariosDisponibles.includes(messageContent)) {
                await client.sendMessage(senderId, 
                    'Por favor, selecciona una hora válida de la lista proporcionada.'
                );
                return;
            }
            
            state.hora = messageContent;
            state.step = 'confirmacion';
            
            // Verificar disponibilidad en Calendar
            const disponible = await verificarDisponibilidad(state.fecha, state.hora);
            
            if (!disponible) {
                await client.sendMessage(senderId, 
                    'Lo sentimos, ese horario ya está ocupado. Por favor, selecciona otro horario:'
                );
                state.step = 'hora';
                return;
            }
            
            // Mostrar resumen de la cita para confirmación
            await client.sendMessage(senderId, 
                `📝 *Resumen de tu cita:*\n\n` +
                `Nombre: ${state.nombre}\n` +
                `Teléfono: ${state.telefono}\n` +
                `Servicio: ${servicios[state.servicio].nombre}\n` +
                `Fecha: ${state.fecha}\n` +
                `Hora: ${state.hora}\n\n` +
                `Para confirmar tu cita, escribe *CONFIRMAR*. Para cancelar, escribe *CANCELAR*.`
            );
            break;
            
        case 'confirmacion':
            if (messageContent === 'confirmar') {
                // Crear la cita en Google Calendar
                const resultado = await crearCita(
                    state.nombre,
                    state.telefono,
                    state.servicio,
                    state.fecha,
                    state.hora
                );
                
                if (resultado) {
                    await client.sendMessage(senderId, 
                        `✅ *¡Cita confirmada!*\n\n` +
                        `Tu cita para ${servicios[state.servicio].nombre} ha sido agendada para el ${state.fecha} a las ${state.hora}.\n\n` +
                        `Te recordaremos un día antes por este medio. Si necesitas cambiar o cancelar tu cita, por favor contáctanos con al menos 24 horas de anticipación.\n\n` +
                        `¡Gracias por elegir Peluquería Estilo!`
                    );
                } else {
                    await client.sendMessage(senderId, 
                        `❌ Lo sentimos, hubo un problema al agendar tu cita. Por favor, intenta nuevamente o contáctanos directamente al teléfono de la peluquería.`
                    );
                }
            } else if (messageContent === 'cancelar') {
                await client.sendMessage(senderId, 
                    `Entendido, hemos cancelado el proceso de reserva. Si deseas agendar en otro momento, solo escribe "Hola" para comenzar nuevamente.`
                );
            } else {
                await client.sendMessage(senderId, 
                    `Por favor, escribe *CONFIRMAR* para agendar tu cita o *CANCELAR* para cancelar el proceso.`
                );
                return;
            }
            
            // Reiniciar el estado para futuras conversaciones
            delete conversationStates[senderId];
            break;
    }
});

// Iniciar el cliente de WhatsApp
client.initialize();