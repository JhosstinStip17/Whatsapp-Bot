### Descripcion del funcionamiento del Bot

Este bot de WhatsApp tiene la capacidad de dar informacion al cliente de la tienda y ademas agendar citas el cliente lo desea, para eso utiliza la **API** de **ChatPDF** la cual es la encargada de leer la información de la tienda por medio de un PDF, en caso de agendar una cita el proceso sera realizo por procesos creado en la plataforma de **MAKE** la cual posee dos procesos, **AGENDAR** y **CONSULTAR**. Este agendamiento se registra en el google **Calendar** y se añade a una libro de **Excel** el cual despues es consultado para verificar la disponibilidad de la tienda.


### Requisitos previos:

- Node.js instalado en tu servidor
- Una cuenta de WhatsApp para el negocio
- Cuenta en MAKE
- Procesos de agendamiento y consulta en MAKE
- Cuenta en ChatPDF
- Un chat iniciado en ChatPDF


### configurar el proyecto:

- npm init -y
- npm install whatsapp-web.js qrcode-terminal fs readline axios dotenv
- Colocar La API, ID, Links en el archivo .env


