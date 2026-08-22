import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { User } from '../users/schemas/user.schema';
import { Order } from '../orders/schemas/order.schema';
import { ProductsService } from '../products/products.service';
import { SellersService } from '../sellers/sellers.service';
import { OrderStatus } from '../../common/enums/order-status.enum';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    private readonly productsService: ProductsService,
    private readonly sellersService: SellersService,
    private readonly configService: ConfigService,
  ) {}

  async getStats() {
    const threshold =
      this.configService.get<number>('lowStockThreshold') ?? 5;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const paidStatuses = [
      OrderStatus.Paid,
      OrderStatus.Shipped,
      OrderStatus.Delivered,
    ];

    const [
      usersCount,
      ordersCount,
      productsCount,
      sellersCount,
      lowStock,
      todayOrders,
      revenueAgg,
      recentOrders,
    ] = await Promise.all([
      this.userModel.countDocuments().exec(),
      this.orderModel.countDocuments().exec(),
      this.productsService.countAll(),
      this.sellersService.countAll(),
      this.productsService.countLowStock(threshold),
      this.orderModel.countDocuments({ createdAt: { $gte: startOfDay } }).exec(),
      this.orderModel
        .aggregate<{ total: number }>([
          { $match: { status: { $in: paidStatuses } } },
          { $group: { _id: null, total: { $sum: '$total' } } },
        ])
        .exec(),
      this.orderModel.find().sort({ createdAt: -1 }).limit(10).lean().exec(),
    ]);

    return {
      usersCount,
      ordersCount,
      productsCount,
      sellersCount,
      lowStock,
      todayOrders,
      revenue: revenueAgg[0]?.total ?? 0,
      recentOrders,
    };
  }

  async getSoldProducts() {
    const paidStatuses = [
      OrderStatus.Paid,
      OrderStatus.Shipped,
      OrderStatus.Delivered,
    ];

    return this.orderModel
      .aggregate([
        { $match: { status: { $in: paidStatuses } } },
        { $unwind: '$items' },
        {
          $addFields: {
            billedQty: {
              $cond: [
                { $eq: ['$items.fulfillmentStatus', 'unavailable'] },
                0,
                { $ifNull: ['$items.givenQuantity', '$items.quantity'] },
              ],
            },
          },
        },
        {
          $project: {
            lines: {
              $concatArrays: [
                {
                  $cond: [
                    { $gt: ['$billedQty', 0] },
                    [
                      {
                        productId: '$items.productId',
                        name: '$items.name',
                        slug: '$items.slug',
                        quantity: '$billedQty',
                        unitPrice: '$items.unitPrice',
                      },
                    ],
                    [],
                  ],
                },
                {
                  $map: {
                    input: { $ifNull: ['$items.substitutes', []] },
                    as: 's',
                    in: {
                      productId: '$$s.productId',
                      name: '$$s.name',
                      slug: '$$s.slug',
                      quantity: '$$s.quantity',
                      unitPrice: '$$s.unitPrice',
                    },
                  },
                },
              ],
            },
          },
        },
        { $unwind: '$lines' },
        { $match: { 'lines.quantity': { $gt: 0 } } },
        {
          $group: {
            _id: '$lines.productId',
            name: { $first: '$lines.name' },
            slug: { $first: '$lines.slug' },
            quantitySold: { $sum: '$lines.quantity' },
            revenue: {
              $sum: { $multiply: ['$lines.quantity', '$lines.unitPrice'] },
            },
          },
        },
        { $sort: { quantitySold: -1 } },
      ])
      .exec();
  }
}
