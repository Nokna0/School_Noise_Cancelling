import numpy as np
import matplotlib.pyplot as plt
import math
import random

def sin(x):
    x = np.linspace(0, x*math.pi, 1000)
    y = np.sin(x)

    plt.plot(x, y)
    plt.show()

def noise():
    x = np.linspace(0, x*math.pi, 1000)
    y = random()

    plt.plot(x, y)
    plt.show()