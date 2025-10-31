import { ENV } from '../config/env';



export const CashInPayload ={
  
    unique_id: "+639123456789",
    externalPaymentId: "extid",
    line_items: [
        {
            name: "testing cashin",
            description: "testing cashin payment initiate test",
            amount: ENV.AMOUNT,
            currency: "PHP",
            quantity: 1
        }
    ],
    payment_methods: [
        "qrph"
    ],
    merchant_id: ENV.MERCHANT_ID,

  }

 

